import type { Database } from 'bun:sqlite';

import { makeScheduleToolExecutor } from './dynamic-tools';
import type { ScheduleJournal } from './journal';
import type { ScheduleToolCall, ScheduleToolResult } from './model';
import { authorizeScheduleToolCall, type ToolAuthorization } from './tool-authorization';
import {
  persistScheduleToolFailure,
  persistScheduleToolGateFailure,
  rejectScheduleToolCallDrift,
} from './tool-call-store';

type AuthorizationResult =
  | ToolAuthorization
  | { readonly kind: 'Response'; readonly response: ScheduleToolResult };

interface ScheduleToolCallBoundary {
  readonly authorize: (call: ScheduleToolCall) => AuthorizationResult;
  readonly execute: (call: ScheduleToolCall, pendingFailure?: string) => ScheduleToolResult;
  readonly reject: (call: ScheduleToolCall, message: string) => ScheduleToolResult;
}

interface ScheduleToolCallBoundaryOptions {
  readonly database: Database;
  readonly journal: ScheduleJournal;
  readonly now: () => Date;
  readonly onError: (cause: unknown) => void;
  readonly onMutation: () => void;
}

const failed = (text: string): ScheduleToolResult => ({ changed: false, success: false, text });

const reportBoundaryError = (options: ScheduleToolCallBoundaryOptions, cause: unknown): void => {
  try {
    options.onError(cause);
  } catch {
    // The boundary remains total even when its reporter is unhealthy.
  }
};

const readNow = (options: ScheduleToolCallBoundaryOptions): Date | null => {
  try {
    return options.now();
  } catch (error) {
    reportBoundaryError(options, error);
    return null;
  }
};

const rejectToolCall = (
  options: ScheduleToolCallBoundaryOptions,
  call: ScheduleToolCall,
  message: string,
): ScheduleToolResult => {
  const at = readNow(options);
  if (at === null) {
    return failed(message);
  }
  try {
    return persistScheduleToolGateFailure(options.database, call, at, message);
  } catch (error) {
    reportBoundaryError(options, error);
    return failed(message);
  }
};

const authorizeToolCall = (
  options: ScheduleToolCallBoundaryOptions,
  call: ScheduleToolCall,
): AuthorizationResult => {
  try {
    const drift = rejectScheduleToolCallDrift(options.database, call);
    return drift === null
      ? authorizeScheduleToolCall(options.database, call)
      : { kind: 'Response', response: drift };
  } catch (error) {
    reportBoundaryError(options, error);
    return {
      kind: 'Response',
      response: rejectToolCall(options, call, 'schedule tool call authorization failed'),
    };
  }
};

const makeScheduleToolCallBoundary = (
  options: ScheduleToolCallBoundaryOptions,
): ScheduleToolCallBoundary => {
  const executeTool = makeScheduleToolExecutor(
    options.database,
    options.journal,
    options.onMutation,
  );
  const persistFailure = (
    call: ScheduleToolCall,
    message: string,
    cause: unknown,
    at: Date | null,
  ): ScheduleToolResult => {
    reportBoundaryError(options, cause);
    if (at === null) {
      return failed(message);
    }
    try {
      return persistScheduleToolFailure(options.database, call, at, message);
    } catch (error) {
      reportBoundaryError(options, error);
      return failed(message);
    }
  };
  return {
    authorize: (call) => authorizeToolCall(options, call),
    execute: (call, pendingFailure) => {
      const at = readNow(options);
      if (at === null) {
        return failed(pendingFailure ?? 'schedule tool call failed');
      }
      try {
        return executeTool(call, at, pendingFailure);
      } catch (error) {
        return persistFailure(call, pendingFailure ?? 'schedule tool call failed', error, at);
      }
    },
    reject: (call, message) => rejectToolCall(options, call, message),
  };
};

export { makeScheduleToolCallBoundary };
export type { AuthorizationResult, ScheduleToolCallBoundary };
