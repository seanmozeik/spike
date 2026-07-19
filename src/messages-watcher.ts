import { watch as nodeWatchPath } from 'node:fs';
import path from 'node:path';

import { Effect } from 'effect';

import { fileIdentity, filenameText } from './messages-watcher-files';
import { makeWatcherRestartOwner } from './messages-watcher-restart';
import {
  MessagesWatcherError as WatcherError,
  type MessagesDatabaseEvent,
  type MessagesWatcher,
  type MessagesWatcherDiagnostics,
  type MessagesWatcherHandlers,
  type MessagesWatcherOptions,
  type OpenMessagesWatcher,
  type OwnedWatcher,
  type WatcherRuntime,
  type WatchPath,
} from './messages-watcher-types';

const DEFAULT_RESTART_DELAY_MS = 1000;

const defaultWatchPath: WatchPath = (target, listener) => nodeWatchPath(target, listener);

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';

const watcherError = (runtime: WatcherRuntime, operation: string, cause: unknown): WatcherError =>
  new WatcherError({
    cause,
    databasePath: runtime.databasePath,
    message: `Messages database watcher failed during ${operation}`,
    operation,
  });

const reportWatcherError = (runtime: WatcherRuntime, operation: string, cause: unknown): void => {
  if (runtime.state.closed) {
    return;
  }
  const error = watcherError(runtime, operation, cause);
  runtime.state.lastError = error;
  runtime.handlers.onError(error);
};

const closeOwnedWatcher = (owned: OwnedWatcher | null | undefined): void => {
  if (owned === null || owned === undefined) {
    return;
  }
  owned.handle.close();
};

const classifyEvent = (
  runtime: WatcherRuntime,
  eventType: string,
  filename: string | null,
): MessagesDatabaseEvent => {
  if (filename !== runtime.databaseName && filename !== null) {
    return { kind: 'Changed' };
  }
  const currentIdentity = fileIdentity(runtime.databasePath);
  const identityChanged = currentIdentity !== runtime.databaseIdentity;
  runtime.databaseIdentity = currentIdentity;
  return eventType === 'rename' || filename === null || identityChanged
    ? { kind: 'DatabaseReplaced' }
    : { kind: 'Changed' };
};

const observeEvent = (runtime: WatcherRuntime, event: MessagesDatabaseEvent): void => {
  if (runtime.state.closed) {
    return;
  }
  runtime.state.eventCount += 1;
  runtime.state.lastEventAt = runtime.now().toISOString();
  runtime.handlers.onEvent(event);
};

const handleFileError = (
  runtime: WatcherRuntime,
  filename: string,
  owned: OwnedWatcher,
  cause: Error,
): void => {
  if (runtime.fileWatchers.get(filename)?.identity !== owned.identity) {
    return;
  }
  runtime.fileWatchers.delete(filename);
  closeOwnedWatcher(owned);
  reportWatcherError(runtime, `watch-file:${filename}`, cause);
  runtime.restart.schedule();
};

const armFileWatcher = (runtime: WatcherRuntime, filename: string): void => {
  closeOwnedWatcher(runtime.fileWatchers.get(filename));
  runtime.fileWatchers.delete(filename);
  try {
    const identity = {};
    const handle = runtime.watchPath(path.join(runtime.directoryPath, filename), (eventType) => {
      observeEvent(runtime, classifyEvent(runtime, eventType, filename));
    });
    const owned = { handle, identity } satisfies OwnedWatcher;
    handle.on('error', (cause) => {
      handleFileError(runtime, filename, owned, cause);
    });
    runtime.fileWatchers.set(filename, owned);
  } catch (error) {
    if (!isMissing(error)) {
      reportWatcherError(runtime, `watch-file:${filename}`, error);
    }
    if (filename === runtime.databaseName || !isMissing(error)) {
      runtime.restart.schedule();
    }
  }
};

const observeDirectory = (
  runtime: WatcherRuntime,
  eventType: string,
  filename: Buffer | null | string,
): void => {
  const changed = filenameText(filename);
  if (changed !== null && !runtime.targets.has(changed)) {
    return;
  }
  observeEvent(runtime, classifyEvent(runtime, eventType, changed));
  const targets = changed === null ? runtime.targets : [changed];
  for (const target of targets) {
    armFileWatcher(runtime, target);
  }
};

const handleDirectoryError = (runtime: WatcherRuntime, owned: OwnedWatcher, cause: Error): void => {
  if (runtime.directoryWatcher?.identity !== owned.identity) {
    return;
  }
  runtime.directoryWatcher = null;
  closeOwnedWatcher(owned);
  reportWatcherError(runtime, 'watch-directory', cause);
  runtime.restart.schedule();
};

const armDirectoryWatcher = (runtime: WatcherRuntime): void => {
  closeOwnedWatcher(runtime.directoryWatcher);
  runtime.directoryWatcher = null;
  const identity = {};
  const handle = runtime.watchPath(runtime.directoryPath, (eventType, filename) => {
    observeDirectory(runtime, eventType, filename);
  });
  const owned = { handle, identity } satisfies OwnedWatcher;
  handle.on('error', (cause) => {
    handleDirectoryError(runtime, owned, cause);
  });
  runtime.directoryWatcher = owned;
};

const restartWatchers = (runtime: WatcherRuntime): void => {
  if (runtime.state.closed) {
    return;
  }
  runtime.state.restartCount += 1;
  if (runtime.directoryWatcher === null) {
    try {
      armDirectoryWatcher(runtime);
    } catch (error) {
      reportWatcherError(runtime, 'restart-directory', error);
      runtime.restart.schedule();
      return;
    }
  }
  for (const target of runtime.targets) {
    armFileWatcher(runtime, target);
  }
};

const closeWatcherRuntime = (runtime: WatcherRuntime): void => {
  if (runtime.state.closed) {
    return;
  }
  runtime.state.closed = true;
  runtime.restart.close();
  closeOwnedWatcher(runtime.directoryWatcher);
  runtime.directoryWatcher = null;
  for (const watcher of runtime.fileWatchers.values()) {
    closeOwnedWatcher(watcher);
  }
  runtime.fileWatchers.clear();
};

const makeWatcherHandle = (runtime: WatcherRuntime): MessagesWatcher => ({
  close: (): void => {
    closeWatcherRuntime(runtime);
  },
  diagnostics: (): MessagesWatcherDiagnostics => ({
    activeDirectoryWatcher: runtime.directoryWatcher !== null,
    activeFileWatchers: runtime.fileWatchers.size,
    closed: runtime.state.closed,
    databasePath: runtime.databasePath,
    eventCount: runtime.state.eventCount,
    lastError: runtime.state.lastError,
    lastEventAt: runtime.state.lastEventAt,
    restartCount: runtime.state.restartCount,
    restartScheduled: runtime.restart.scheduled(),
    watchedFiles: [...runtime.targets],
  }),
});

const makeRuntime = (
  databasePath: string,
  handlers: MessagesWatcherHandlers,
  options: MessagesWatcherOptions,
): WatcherRuntime => {
  const databaseName = path.basename(databasePath);
  const restart = makeWatcherRestartOwner(options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS);
  const runtime: WatcherRuntime = {
    databaseIdentity: fileIdentity(databasePath),
    databaseName,
    databasePath,
    directoryPath: path.dirname(databasePath),
    directoryWatcher: null,
    fileWatchers: new Map(),
    handlers,
    now: handlers.now ?? ((): Date => new Date()),
    restart,
    state: { closed: false, eventCount: 0, lastError: null, lastEventAt: null, restartCount: 0 },
    targets: new Set([
      databaseName,
      `${databaseName}-journal`,
      `${databaseName}-shm`,
      `${databaseName}-wal`,
    ]),
    watchPath: options.watchPath ?? defaultWatchPath,
  };
  restart.setRestart(() => {
    restartWatchers(runtime);
  });
  return runtime;
};

const openMessagesWatcher = Effect.fn('MessagesWatcher.open')(function* openMessagesWatcher(
  databasePath: string,
  handlers: MessagesWatcherHandlers,
  options: MessagesWatcherOptions = {},
) {
  const runtime = makeRuntime(databasePath, handlers, options);
  return yield* Effect.try({
    catch: (cause) => watcherError(runtime, 'watch-directory', cause),
    try: () => {
      try {
        armDirectoryWatcher(runtime);
        for (const target of runtime.targets) {
          armFileWatcher(runtime, target);
        }
        return makeWatcherHandle(runtime);
      } catch (error) {
        closeWatcherRuntime(runtime);
        throw error;
      }
    },
  });
});

const makeMessagesWatcher =
  (databasePath: string, options: MessagesWatcherOptions = {}): OpenMessagesWatcher =>
  (handlers): Effect.Effect<MessagesWatcher, WatcherError> =>
    openMessagesWatcher(databasePath, handlers, options);

export { makeMessagesWatcher, openMessagesWatcher };
export { MessagesWatcherError } from './messages-watcher-types';
export type {
  MessagesDatabaseEvent,
  MessagesWatcher,
  MessagesWatcherDiagnostics,
  MessagesWatcherHandlers,
  MessagesWatcherOptions,
  OpenMessagesWatcher,
  WatchHandle,
  WatchListener,
  WatchPath,
} from './messages-watcher-types';
