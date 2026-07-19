import { Schema, type Effect } from 'effect';

class MessagesWatcherError extends Schema.TaggedErrorClass<MessagesWatcherError>()(
  'MessagesWatcherError',
  {
    cause: Schema.Defect(),
    databasePath: Schema.String,
    message: Schema.String,
    operation: Schema.String,
  },
) {}

type MessagesDatabaseEvent = { readonly kind: 'Changed' } | { readonly kind: 'DatabaseReplaced' };

interface MessagesWatcherDiagnostics {
  readonly activeDirectoryWatcher: boolean;
  readonly activeFileWatchers: number;
  readonly closed: boolean;
  readonly databasePath: string;
  readonly eventCount: number;
  readonly lastError: MessagesWatcherError | null;
  readonly lastEventAt: string | null;
  readonly restartCount: number;
  readonly restartScheduled: boolean;
  readonly watchedFiles: readonly string[];
}

interface MessagesWatcherHandlers {
  readonly now?: () => Date;
  readonly onError: (error: MessagesWatcherError) => void;
  readonly onEvent: (event: MessagesDatabaseEvent) => void;
}

interface MessagesWatcher {
  readonly close: () => void;
  readonly diagnostics: () => MessagesWatcherDiagnostics;
}

interface WatchHandle {
  readonly close: () => void;
  readonly on: (event: 'error', listener: (cause: Error) => void) => WatchHandle;
}

type WatchListener = (eventType: string, filename: Buffer | null | string) => void;
type WatchPath = (target: string, listener: WatchListener) => WatchHandle;

interface MessagesWatcherOptions {
  readonly restartDelayMs?: number;
  readonly watchPath?: WatchPath;
}

type OpenMessagesWatcher = (
  handlers: MessagesWatcherHandlers,
) => Effect.Effect<MessagesWatcher, MessagesWatcherError>;

interface OwnedWatcher {
  readonly handle: WatchHandle;
  readonly identity: object;
}

interface WatcherState {
  closed: boolean;
  eventCount: number;
  lastError: MessagesWatcherError | null;
  lastEventAt: string | null;
  restartCount: number;
}

interface WatcherRestartOwner {
  readonly close: () => void;
  readonly schedule: () => void;
  readonly scheduled: () => boolean;
  readonly setRestart: (restart: () => void) => void;
}

interface WatcherRuntime {
  databaseIdentity: string | null;
  readonly databaseName: string;
  readonly databasePath: string;
  directoryWatcher: OwnedWatcher | null;
  readonly directoryPath: string;
  readonly fileWatchers: Map<string, OwnedWatcher>;
  readonly handlers: MessagesWatcherHandlers;
  readonly now: () => Date;
  readonly restart: WatcherRestartOwner;
  readonly state: WatcherState;
  readonly targets: ReadonlySet<string>;
  readonly watchPath: WatchPath;
}

export { MessagesWatcherError };
export type {
  MessagesDatabaseEvent,
  MessagesWatcher,
  MessagesWatcherDiagnostics,
  MessagesWatcherHandlers,
  MessagesWatcherOptions,
  OpenMessagesWatcher,
  OwnedWatcher,
  WatchHandle,
  WatcherRuntime,
  WatcherRestartOwner,
  WatchListener,
  WatchPath,
};
