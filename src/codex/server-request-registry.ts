type JsonRpcId = number | string;

interface CodexServerRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

interface ServerRequestRegistry {
  readonly publish: (request: CodexServerRequest) => void;
  readonly resolve: (id: JsonRpcId) => void;
  readonly subscribe: (
    methods: ReadonlySet<string>,
    listener: (request: CodexServerRequest) => void,
  ) => () => void;
}

const requestKey = (id: JsonRpcId): string => `${typeof id}:${String(id)}`;

const makeServerRequestRegistry = (): ServerRequestRegistry => {
  const pending = new Map<string, CodexServerRequest>();
  const listeners = new Map<(request: CodexServerRequest) => void, ReadonlySet<string>>();
  return {
    publish: (request) => {
      pending.set(requestKey(request.id), request);
      for (const [listener, methods] of listeners) {
        if (methods.has(request.method)) {
          listener(request);
        }
      }
    },
    resolve: (id) => {
      pending.delete(requestKey(id));
    },
    subscribe: (methods, listener) => {
      const replay = [...pending.values()].filter((request) => methods.has(request.method));
      listeners.set(listener, methods);
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
