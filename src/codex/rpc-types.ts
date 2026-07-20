import type { JsonRpcNotification } from './notification-registry';
import type { CodexServerRequest } from './server-request-registry';
import type { CodexLogMode } from './stderr-log';

type JsonRpcId = number | string;

interface JsonRpcError {
  readonly code: number;
  readonly data?: unknown;
  readonly message: string;
}

interface RpcHandle {
  readonly addConnectionCloseListener: (listener: () => void) => () => void;
  readonly addNotificationListener: (
    listener: (notification: JsonRpcNotification) => void,
  ) => () => void;
  readonly addServerRequestListener: (
    methods: ReadonlySet<string>,
    listener: (request: CodexServerRequest) => void,
  ) => () => void;
  readonly close: () => Promise<void>;
  readonly notify: (method: string, params?: unknown) => Promise<void>;
  readonly request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  readonly respondToServerRequest: (id: JsonRpcId, result: unknown) => Promise<void>;
  readonly respondToServerRequestError: (id: JsonRpcId, error: JsonRpcError) => Promise<void>;
}

interface SpawnRpcOptions {
  readonly codexExecutable: string;
  readonly codexHome: string;
  readonly logMode: CodexLogMode;
  readonly stderrLog: string;
  readonly timeoutMs?: number;
}

export type { JsonRpcError, JsonRpcId, RpcHandle, SpawnRpcOptions };
