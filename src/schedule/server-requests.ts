import type { Database } from 'bun:sqlite';

import { Schema } from 'effect';

import { SCHEDULE_REQUEST_METHODS } from '../codex/rpc-server-request';
import type { CodexRuntime } from '../codex/runtime-types';
import type { CodexServerRequest } from '../codex/server-request-registry';
import type { ScheduleJournal } from './journal';
import { CurrentTimeReadParams, ScheduleToolCallParams, type ScheduleToolCall } from './model';
import {
  makePendingScheduleToolCalls,
  type PendingScheduleToolCalls,
  type ScheduleRequestScheduler,
} from './pending-tool-calls';
import { makeScheduleRpcResponse, type ScheduleRpcResponse } from './rpc-response';
import { makeScheduleToolCallBoundary, type ScheduleToolCallBoundary } from './tool-call-boundary';

interface ScheduleServerRequests {
  readonly attemptAccepted: () => void;
  readonly close: () => void;
}

interface ScheduleServerRequestOptions {
  readonly database: Database;
  readonly journal: ScheduleJournal;
  readonly now: () => Date;
  readonly onError: (cause: unknown) => void;
  readonly onMutation: () => void;
  readonly pendingTimeoutMs: number;
  readonly runtime: CodexRuntime;
  readonly scheduler: ScheduleRequestScheduler;
}

const decoderOptions = { onExcessProperty: 'error' } as const;
const MILLISECONDS_PER_SECOND = 1000;

const decodeToolCall = (request: CodexServerRequest): ScheduleToolCall | null => {
  try {
    return Schema.decodeUnknownSync(ScheduleToolCallParams, decoderOptions)(request.params);
  } catch {
    return null;
  }
};

const handleToolCall = (
  request: CodexServerRequest,
  boundary: ScheduleToolCallBoundary,
  pending: PendingScheduleToolCalls,
  response: ScheduleRpcResponse,
): void => {
  const call = decodeToolCall(request);
  if (call === null) {
    response.dynamicTool(request.id, false, 'invalid schedule tool arguments');
    return;
  }
  const authorization = boundary.authorize(call);
  if (authorization.kind === 'Pending') {
    pending.queue(request, call);
    return;
  }
  if (authorization.kind === 'Response') {
    response.dynamicTool(request.id, false, authorization.response.text);
    return;
  }
  if (authorization.kind === 'Rejected') {
    const rejected = boundary.reject(call, authorization.message);
    response.dynamicTool(request.id, false, rejected.text);
    return;
  }
  const result = boundary.execute(call);
  response.dynamicTool(request.id, result.success, result.text);
};

const handleCurrentTime = (
  request: CodexServerRequest,
  options: ScheduleServerRequestOptions,
  response: ScheduleRpcResponse,
): void => {
  try {
    Schema.decodeUnknownSync(CurrentTimeReadParams, decoderOptions)(request.params);
  } catch (error) {
    response.report(error);
    response.error(request.id, { code: -32_602, message: 'Invalid currentTime/read params' });
    return;
  }
  try {
    response.result(request.id, {
      currentTimeAt: Math.floor(options.now().getTime() / MILLISECONDS_PER_SECOND),
    });
  } catch (error) {
    response.report(error);
    response.error(request.id, { code: -32_603, message: 'Unable to read current time' });
  }
};

const makeScheduleServerRequests = (
  options: ScheduleServerRequestOptions,
): ScheduleServerRequests => {
  const response = makeScheduleRpcResponse(options.runtime, options.onError);
  const boundary = makeScheduleToolCallBoundary(options);
  const pending = makePendingScheduleToolCalls({
    boundary,
    response,
    scheduler: options.scheduler,
    timeoutMs: options.pendingTimeoutMs,
  });
  const listener = (request: CodexServerRequest): void => {
    try {
      if (request.method === 'item/tool/call') {
        handleToolCall(request, boundary, pending, response);
      } else {
        handleCurrentTime(request, options, response);
      }
    } catch (error) {
      response.report(error);
      response.dynamicTool(request.id, false, 'schedule request failed');
    }
  };
  let unsubscribe: null | (() => void) = options.runtime.addServerRequestListener(
    SCHEDULE_REQUEST_METHODS,
    listener,
  );
  return {
    attemptAccepted: pending.flush,
    close: () => {
      try {
        unsubscribe?.();
      } catch (error) {
        response.report(error);
      }
      unsubscribe = null;
      pending.close();
    },
  };
};

export { makeScheduleServerRequests };
export type { ScheduleServerRequests };
