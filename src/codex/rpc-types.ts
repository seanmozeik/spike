import type { JsonRpcNotification } from './notification-registry';
import type { CodexServerRequest } from './server-request-registry';

type JsonRpcId = number | string;

interface RpcHandle {
  readonly addConnectionCloseListener: (listener: () => void) => () => void;
  readonly addNotificationListener: (
    listener: (notification: JsonRpcNotification) => void,
  ) => () => void;
  readonly addServerRequestListener: (
    listener: (request: CodexServerRequest) => void,
  ) => () => void;
  readonly close: () => Promise<void>;
  readonly notify: (method: string, params?: unknown) => Promise<void>;
  readonly request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  readonly respondToServerRequest: (id: JsonRpcId, result: unknown) => Promise<void>;
}

interface SpawnRpcOptions {
  readonly codexExecutable: string;
  readonly codexHome: string;
  readonly stderrLog: string;
  readonly timeoutMs?: number;
}

export type { JsonRpcId, RpcHandle, SpawnRpcOptions };
