import { Effect } from 'effect';

import {
  MessagesWatcherError,
  type MessagesWatcherDiagnostics,
  type MessagesWatcherHandlers,
  type OpenMessagesWatcher,
} from '../src/messages-watcher';

interface WatcherHarness {
  readonly dirty: () => void;
  readonly fail: () => void;
  readonly open: OpenMessagesWatcher;
  readonly replace: () => void;
}

const makeWatcherHarness = (): WatcherHarness => {
  let handlers: MessagesWatcherHandlers | null = null;
  let closed = false;
  const diagnostics = (): MessagesWatcherDiagnostics => ({
    activeDirectoryWatcher: !closed,
    activeFileWatchers: closed ? 0 : 1,
    closed,
    databasePath: '/fixture/chat.db',
    eventCount: 0,
    lastError: null,
    lastEventAt: null,
    restartCount: 0,
    restartScheduled: false,
    watchedFiles: ['chat.db', 'chat.db-shm', 'chat.db-wal'],
  });
  return {
    dirty: () => {
      if (!closed) {
        handlers?.onEvent({ kind: 'Changed' });
      }
    },
    fail: () => {
      if (!closed) {
        handlers?.onError(
          new MessagesWatcherError({
            cause: new Error('scripted watcher failure'),
            databasePath: '/fixture/chat.db',
            message: 'Messages database watcher failed',
            operation: 'watch-file',
          }),
        );
      }
    },
    open: (nextHandlers) =>
      Effect.sync(() => {
        handlers = nextHandlers;
        return {
          close: (): void => {
            closed = true;
          },
          diagnostics,
        };
      }),
    replace: () => {
      if (!closed) {
        handlers?.onEvent({ kind: 'DatabaseReplaced' });
      }
    },
  };
};

export { makeWatcherHarness };
export type { WatcherHarness };
