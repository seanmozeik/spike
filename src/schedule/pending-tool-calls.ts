import type { CodexServerRequest } from '../codex/server-request-registry';
import type { ScheduleToolCall, ScheduleToolResult } from './model';
import type { ScheduleRpcResponse } from './rpc-response';
import type { AuthorizationResult, ScheduleToolCallBoundary } from './tool-call-boundary';

interface ScheduleRequestScheduler {
  readonly schedule: (delayMs: number, task: () => void) => () => void;
}

interface PendingScheduleToolCalls {
  readonly close: () => void;
  readonly flush: () => void;
  readonly queue: (request: CodexServerRequest, call: ScheduleToolCall) => void;
}

interface PendingEntry {
  readonly call: ScheduleToolCall;
  readonly cancelTimeout: () => void;
  readonly request: CodexServerRequest;
}

interface PendingOptions {
  readonly boundary: ScheduleToolCallBoundary;
  readonly response: ScheduleRpcResponse;
  readonly scheduler: ScheduleRequestScheduler;
  readonly timeoutMs: number;
}

const systemScheduleRequestScheduler: ScheduleRequestScheduler = {
  schedule: (delayMs, task) => {
    const timer = setTimeout(task, delayMs);
    return (): void => {
      clearTimeout(timer);
    };
  },
};

const requestKey = (request: CodexServerRequest): string =>
  `${typeof request.id}:${String(request.id)}`;

const send = (options: PendingOptions, entry: PendingEntry, result: ScheduleToolResult): void => {
  options.response.dynamicTool(entry.request.id, result.success, result.text);
};

const take = (
  options: PendingOptions,
  pending: Map<string, PendingEntry>,
  entry: PendingEntry,
): boolean => {
  const key = requestKey(entry.request);
  if (pending.get(key) !== entry) {
    return false;
  }
  pending.delete(key);
  try {
    entry.cancelTimeout();
  } catch (error) {
    options.response.report(error);
  }
  return true;
};

const finish = (
  options: PendingOptions,
  pending: Map<string, PendingEntry>,
  entry: PendingEntry,
  failure?: string,
): void => {
  if (take(options, pending, entry)) {
    send(options, entry, options.boundary.execute(entry.call, failure));
  }
};

const finishAuthorization = (
  options: PendingOptions,
  pending: Map<string, PendingEntry>,
  entry: PendingEntry,
  result: AuthorizationResult,
): void => {
  if (result.kind === 'Pending') {
    return;
  }
  if (result.kind === 'Response' && take(options, pending, entry)) {
    send(options, entry, result.response);
    return;
  }
  if (result.kind === 'Rejected' && take(options, pending, entry)) {
    send(options, entry, options.boundary.reject(entry.call, result.message));
    return;
  }
  if (result.kind === 'Authorized') {
    finish(options, pending, entry);
  }
};

const queue = (
  options: PendingOptions,
  pending: Map<string, PendingEntry>,
  request: CodexServerRequest,
  call: ScheduleToolCall,
): void => {
  const key = requestKey(request);
  if (pending.has(key)) {
    return;
  }
  try {
    const entry: PendingEntry = {
      call,
      cancelTimeout: options.scheduler.schedule(options.timeoutMs, () => {
        const queued = pending.get(key);
        if (queued !== undefined) {
          finish(options, pending, queued, 'schedule tool call timed out before turn acceptance');
        }
      }),
      request,
    };
    pending.set(key, entry);
  } catch (error) {
    options.response.report(error);
    const failed = options.boundary.execute(call, 'schedule tool call could not be queued');
    options.response.dynamicTool(request.id, failed.success, failed.text);
  }
};

const makePendingScheduleToolCalls = (options: PendingOptions): PendingScheduleToolCalls => {
  const pending = new Map<string, PendingEntry>();
  return {
    close: () => {
      for (const entry of pending.values()) {
        finish(options, pending, entry, 'schedule tool call was cancelled before turn acceptance');
      }
    },
    flush: () => {
      for (const entry of pending.values()) {
        finishAuthorization(options, pending, entry, options.boundary.authorize(entry.call));
      }
    },
    queue: (request, call) => {
      queue(options, pending, request, call);
    },
  };
};

export { makePendingScheduleToolCalls, systemScheduleRequestScheduler };
export type { PendingScheduleToolCalls, ScheduleRequestScheduler };
