import { Effect } from 'effect';

import type { JsonRpcError, JsonRpcId } from '../codex/rpc-types';
import type { CodexRuntime } from '../codex/runtime-types';

interface ScheduleRpcResponse {
  readonly dynamicTool: (id: JsonRpcId, success: boolean, text: string) => void;
  readonly error: (id: JsonRpcId, error: JsonRpcError) => void;
  readonly report: (cause: unknown) => void;
  readonly result: (id: JsonRpcId, result: unknown) => void;
}

const settle = async (
  operation: () => Promise<void>,
  report: (cause: unknown) => void,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    report(error);
  }
};

const makeScheduleRpcResponse = (
  runtime: CodexRuntime,
  onError: (cause: unknown) => void,
): ScheduleRpcResponse => {
  const report = (cause: unknown): void => {
    try {
      onError(cause);
    } catch {
      // Reporting cannot be allowed to tear down the JSON-RPC reader.
    }
  };
  const send = (operation: () => Promise<void>): void => {
    Effect.runFork(Effect.promise(() => settle(operation, report)));
  };
  const result = (id: JsonRpcId, value: unknown): void => {
    try {
      send(() => runtime.respondToServerRequest(id, value));
    } catch (error) {
      report(error);
    }
  };
  const respondError = (id: JsonRpcId, value: JsonRpcError): void => {
    try {
      send(() => runtime.respondToServerRequestError(id, value));
    } catch (error) {
      report(error);
    }
  };
  return {
    dynamicTool: (id, success, text) => {
      result(id, { contentItems: [{ text, type: 'inputText' }], success });
    },
    error: respondError,
    report,
    result,
  };
};

export { makeScheduleRpcResponse };
export type { ScheduleRpcResponse };
