type JsonRpcId = number | string;

interface CodexServerRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

interface ServerRequestRegistry {
  readonly publish: (request: CodexServerRequest) => void;
  readonly resolve: (id: JsonRpcId) => void;
  readonly subscribe: (listener: (request: CodexServerRequest) => void) => () => void;
}

const requestKey = (id: JsonRpcId): string => `${typeof id}:${String(id)}`;

const makeServerRequestRegistry = (): ServerRequestRegistry => {
  const pending = new Map<string, CodexServerRequest>();
  const listeners = new Set<(request: CodexServerRequest) => void>();
  return {
    publish: (request) => {
      pending.set(requestKey(request.id), request);
      for (const listener of listeners) {
        listener(request);
      }
    },
    resolve: (id) => {
      pending.delete(requestKey(id));
    },
    subscribe: (listener) => {
      const replay = [...pending.values()];
      listeners.add(listener);
      queueMicrotask(() => {
        if (!listeners.has(listener)) {
          return;
        }
        for (const request of replay) {
          listener(request);
        }
      });
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export { makeServerRequestRegistry };
export type { CodexServerRequest, JsonRpcId, ServerRequestRegistry };
