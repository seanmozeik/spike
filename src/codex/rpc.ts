import { appendFile } from 'node:fs/promises';

import { Effect } from 'effect';

import { CodexRuntimeError } from '../errors';
import {
  makeNotificationRegistry,
  type JsonRpcNotification,
  type NotificationRegistry,
} from './notification-registry';
import { routeServerRequest } from './rpc-server-request';

type JsonRpcId = number | string;

interface PendingRequest {
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface RpcHandle {
  readonly addNotificationListener: (
    listener: (notification: JsonRpcNotification) => void,
  ) => () => void;
  readonly close: () => Promise<void>;
  readonly notify: (method: string, params?: unknown) => Promise<void>;
  readonly request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
}

interface RpcRuntime {
  childExited: boolean;
  nextId: number;
  readonly pending: Map<JsonRpcId, PendingRequest>;
}

interface SpawnRpcOptions {
  readonly codexExecutable: string;
  readonly codexHome: string;
  readonly stderrLog: string;
  readonly timeoutMs?: number;
}

interface ChildWriter {
  readonly enqueue: (value: unknown) => void;
  readonly tail: () => Promise<void>;
  readonly write: (value: unknown) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RECENT_NOTIFICATIONS = 2000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isId = (value: unknown): value is JsonRpcId =>
  typeof value === 'number' || typeof value === 'string';

const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
};

const routeResponse = (
  message: Record<string, unknown>,
  pending: Map<JsonRpcId, PendingRequest>,
): boolean => {
  const { id } = message;
  if (!isId(id) || !('result' in message || 'error' in message)) {
    return false;
  }
  const waiter = pending.get(id);
  if (waiter === undefined) {
    return true;
  }
  pending.delete(id);
  clearTimeout(waiter.timeout);
  if ('error' in message) {
    waiter.reject(message['error']);
  } else {
    waiter.resolve(message['result']);
  }
  return true;
};

const routeNotification = (
  message: Record<string, unknown>,
  notifications: NotificationRegistry,
): void => {
  if (typeof message['method'] !== 'string') {
    return;
  }
  const notification = { method: message['method'], params: message['params'] };
  notifications.publish(notification);
};

const readLines = async (
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> => {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') {
        onLine(line);
      }
      newline = buffer.indexOf('\n');
    }
  }
};

const rejectPending = (runtime: RpcRuntime, cause: unknown): void => {
  for (const [id, waiter] of runtime.pending) {
    runtime.pending.delete(id);
    clearTimeout(waiter.timeout);
    waiter.reject(cause);
  }
};

const makeWriter = (stdin: Bun.FileSink): ChildWriter => {
  let tail: Promise<void> = Promise.resolve();
  const write = async (value: unknown): Promise<void> => {
    const written = stdin.write(`${JSON.stringify(value)}\n`);
    if (typeof written !== 'number') {
      await written;
    }
    await stdin.flush();
  };
  const enqueue = (value: unknown): void => {
    const previous = tail;
    tail = (async (): Promise<void> => {
      await previous;
      try {
        await write(value);
      } catch {
        // Pending requests and the exit watcher report a closed peer.
      }
    })();
  };
  return { enqueue, tail: (): Promise<void> => tail, write };
};

const makeRequest =
  (
    runtime: RpcRuntime,
    write: (value: unknown) => Promise<void>,
    timeoutMs: number,
  ): RpcHandle['request'] =>
  async (method: string, params?: unknown, requestTimeoutMs = timeoutMs): Promise<unknown> => {
    if (runtime.childExited) {
      throw new Error('codex app-server already exited');
    }
    const id = runtime.nextId;
    runtime.nextId += 1;
    const deferred = Promise.withResolvers<unknown>();
    const timeout = setTimeout(() => {
      runtime.pending.delete(id);
      deferred.reject(
        new Error(`${method}#${String(id)} timed out after ${String(requestTimeoutMs)}ms`),
      );
    }, requestTimeoutMs);
    runtime.pending.set(id, { reject: deferred.reject, resolve: deferred.resolve, timeout });
    try {
      await write({ id, jsonrpc: '2.0', method, params });
    } catch (error) {
      clearTimeout(timeout);
      runtime.pending.delete(id);
      throw error;
    }
    return deferred.promise;
  };

const makeLineHandler =
  (runtime: RpcRuntime, notifications: NotificationRegistry, enqueue: (value: unknown) => void) =>
  (line: string): void => {
    const message = parseLine(line);
    if (message === null || routeResponse(message, runtime.pending)) {
      return;
    }
    if (routeServerRequest(message, enqueue)) {
      return;
    }
    routeNotification(message, notifications);
  };

const spawnRpcHandle = (options: SpawnRpcOptions): RpcHandle => {
  const runtime: RpcRuntime = { childExited: false, nextId: 1, pending: new Map() };
  const notifications = makeNotificationRegistry(MAX_RECENT_NOTIFICATIONS);
  const child = Bun.spawn([options.codexExecutable, 'app-server', '--listen', 'stdio://'], {
    env: { ...process.env, CODEX_HOME: options.codexHome },
    stderr: 'pipe',
    stdin: 'pipe',
    stdout: 'pipe',
  });
  const writer = makeWriter(child.stdin);
  const stderrWrites: Promise<void>[] = [];
  const stdout = readLines(child.stdout, makeLineHandler(runtime, notifications, writer.enqueue));
  const stderr = readLines(child.stderr, (line) => {
    const write = async (): Promise<void> => {
      try {
        await appendFile(options.stderrLog, `${line}\n`, 'utf8');
      } catch {
        // The daemon log is diagnostic; RPC failures still surface to callers.
      }
    };
    stderrWrites.push(write());
  });
  const watchExit = async (): Promise<void> => {
    const code = await child.exited;
    runtime.childExited = true;
    rejectPending(runtime, new Error(`codex app-server exited with ${String(code)}`));
  };
  const exited = watchExit();
  return {
    addNotificationListener: notifications.subscribe,
    close: async () => {
      runtime.childExited = true;
      rejectPending(runtime, new Error('codex app-server closed'));
      child.kill();
      await Promise.allSettled([child.exited, writer.tail(), stdout, stderr, exited]);
      await Promise.allSettled(stderrWrites);
    },
    notify: (method, params) => writer.write({ jsonrpc: '2.0', method, params }),
    request: makeRequest(runtime, writer.write, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
};

const initializeRpc = Effect.fn('SpikeCodex.initialize')((handle: RpcHandle) =>
  Effect.tryPromise({
    catch: (cause) =>
      new CodexRuntimeError({
        cause,
        message: 'failed to initialize Codex app-server',
        operation: 'initialize',
      }),
    try: async () => {
      await handle.request('initialize', {
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ['item/agentMessage/delta'],
        },
        clientInfo: { name: 'spike_agent', title: 'Spike iMessage Agent', version: '0.0.1' },
      });
      await handle.notify('initialized');
    },
  }),
);

export { initializeRpc, spawnRpcHandle };
export type { JsonRpcNotification } from './notification-registry';
export type { RpcHandle, SpawnRpcOptions };
