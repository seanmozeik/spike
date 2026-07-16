interface JsonRpcNotification {
  readonly method: string;
  readonly params: unknown;
}

interface NotificationRegistry {
  readonly publish: (notification: JsonRpcNotification) => void;
  readonly subscribe: (listener: (notification: JsonRpcNotification) => void) => () => void;
}

const makeNotificationRegistry = (historyLimit: number): NotificationRegistry => {
  const history: JsonRpcNotification[] = [];
  const listeners = new Set<(notification: JsonRpcNotification) => void>();

  return {
    publish: (notification) => {
      history.push(notification);
      if (history.length > historyLimit) {
        history.splice(0, history.length - historyLimit);
      }
      for (const listener of listeners) {
        listener(notification);
      }
    },
    subscribe: (listener) => {
      const replay = [...history];
      listeners.add(listener);
      queueMicrotask(() => {
        if (!listeners.has(listener)) {
          return;
        }
        for (const notification of replay) {
          listener(notification);
        }
      });
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export { makeNotificationRegistry };
export type { JsonRpcNotification, NotificationRegistry };
