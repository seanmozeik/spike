import type { JsonRpcNotification, RpcHandle } from '../src/codex/rpc';

interface RequestRecord {
  readonly method: string;
  readonly params: unknown;
  readonly timeoutMs: number | undefined;
}

interface FakeHandle {
  readonly closeListenerCount: () => number;
  readonly emit: (notification: JsonRpcNotification) => void;
  readonly emitClose: () => void;
  readonly handle: RpcHandle;
  readonly notificationListenerCount: () => number;
  readonly requests: RequestRecord[];
}

const makeRequest = (
  requests: RequestRecord[],
  missingThread: boolean,
  unloadedThread: boolean,
): RpcHandle['request'] => {
  let threadReads = 0;
  return (method, params, timeoutMs) => {
    requests.push({ method, params, timeoutMs });
    if (missingThread && (method === 'thread/resume' || method === 'thread/read')) {
      const error = new Error('no rollout found for thread id thread-missing');
      Object.assign(error, { code: -32_600 });
      return Promise.reject(error);
    }
    if (unloadedThread && method === 'thread/read' && threadReads === 0) {
      threadReads += 1;
      const error = new Error('thread not loaded: thread');
      Object.assign(error, { code: -32_600 });
      return Promise.reject(error);
    }
    if (method === 'thread/loaded/list') {
      return Promise.resolve({ data: [], nextCursor: null });
    }
    if (method === 'thread/start') {
      return Promise.resolve({ thread: { id: 'thread' } });
    }
    if (method === 'turn/start') {
      return Promise.resolve({ turn: { id: 'turn' } });
    }
    if (method === 'thread/read') {
      return Promise.resolve({ thread: { id: 'thread', turns: [] } });
    }
    return Promise.resolve({});
  };
};

const makeHandle = (missingThread = false, unloadedThread = false): FakeHandle => {
  const closeListeners = new Set<() => void>();
  const listeners: ((notification: JsonRpcNotification) => void)[] = [];
  const requests: RequestRecord[] = [];
  const handle: RpcHandle = {
    addConnectionCloseListener: (listener) => {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    addNotificationListener: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      };
    },
    addServerRequestListener: () => (): void => undefined,
    close: () => Promise.resolve(),
    notify: () => Promise.resolve(),
    request: makeRequest(requests, missingThread, unloadedThread),
    respondToServerRequest: () => Promise.resolve(),
    respondToServerRequestError: () => Promise.resolve(),
  };
  return {
    closeListenerCount: () => closeListeners.size,
    emit: (notification: JsonRpcNotification): void => {
      for (const listener of listeners) {
        listener(notification);
      }
    },
    emitClose: (): void => {
      for (const listener of closeListeners) {
        listener();
      }
    },
    handle,
    notificationListenerCount: () => listeners.length,
    requests,
  };
};

export { makeHandle };
export type { FakeHandle, RequestRecord };
