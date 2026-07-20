import type { MessagesWatcherDiagnostics } from '../messages-watcher';

interface Counter {
  count: number;
  lastAt: string | null;
}

interface ReconciliationCounter extends Counter {
  failures: number;
  lastFailureAt: string | null;
}

interface EventLoopCounters {
  readonly filesystemEvents: Counter;
  readonly filesystemWakes: Counter;
  readonly ingestionPasses: Counter;
  readonly messagesPolls: Counter;
  readonly messagesQueries: Counter;
  readonly reconciliation: ReconciliationCounter;
  readonly startedAt: string;
  readonly watcherFailures: Counter;
}

interface EngineEventLoopDiagnostics {
  readonly filesystem: {
    readonly events: number;
    readonly lastEventAt: string | null;
    readonly lastWakeAt: string | null;
    readonly wakes: number;
  };
  readonly messages: {
    readonly lastPassAt: string | null;
    readonly lastPollAt: string | null;
    readonly lastQueryAt: string | null;
    readonly passes: number;
    readonly polls: number;
    readonly queries: number;
  };
  readonly reconciliation: {
    readonly failures: number;
    readonly lastAt: string | null;
    readonly lastFailureAt: string | null;
    readonly passes: number;
  };
  readonly startedAt: string;
  readonly watcher: null | {
    readonly active: boolean;
    readonly activeFileWatchers: number;
    readonly closed: boolean;
    readonly failures: number;
    readonly lastFailureAt: string | null;
    readonly restartScheduled: boolean;
    readonly restarts: number;
  };
}

const makeCounter = (): Counter => ({ count: 0, lastAt: null });

const makeEventLoopCounters = (startedAt: Date): EventLoopCounters => ({
  filesystemEvents: makeCounter(),
  filesystemWakes: makeCounter(),
  ingestionPasses: makeCounter(),
  messagesPolls: makeCounter(),
  messagesQueries: makeCounter(),
  reconciliation: { ...makeCounter(), failures: 0, lastFailureAt: null },
  startedAt: startedAt.toISOString(),
  watcherFailures: makeCounter(),
});

const mark = (counter: Counter, at: Date): void => {
  counter.count += 1;
  counter.lastAt = at.toISOString();
};

const markReconciliation = (counters: EventLoopCounters, at: Date, failed: boolean): void => {
  mark(counters.reconciliation, at);
  if (failed) {
    counters.reconciliation.failures += 1;
    counters.reconciliation.lastFailureAt = at.toISOString();
  }
};

const publicWatcher = (
  counters: EventLoopCounters,
  watcher: MessagesWatcherDiagnostics | null,
): EngineEventLoopDiagnostics['watcher'] =>
  watcher === null
    ? null
    : {
        active: !watcher.closed && watcher.activeDirectoryWatcher && watcher.activeFileWatchers > 0,
        activeFileWatchers: watcher.activeFileWatchers,
        closed: watcher.closed,
        failures: counters.watcherFailures.count,
        lastFailureAt: counters.watcherFailures.lastAt,
        restartScheduled: watcher.restartScheduled,
        restarts: watcher.restartCount,
      };

const readEventLoopDiagnostics = (
  counters: EventLoopCounters,
  watcher: MessagesWatcherDiagnostics | null,
): EngineEventLoopDiagnostics => ({
  filesystem: {
    events: counters.filesystemEvents.count,
    lastEventAt: counters.filesystemEvents.lastAt,
    lastWakeAt: counters.filesystemWakes.lastAt,
    wakes: counters.filesystemWakes.count,
  },
  messages: {
    lastPassAt: counters.ingestionPasses.lastAt,
    lastPollAt: counters.messagesPolls.lastAt,
    lastQueryAt: counters.messagesQueries.lastAt,
    passes: counters.ingestionPasses.count,
    polls: counters.messagesPolls.count,
    queries: counters.messagesQueries.count,
  },
  reconciliation: {
    failures: counters.reconciliation.failures,
    lastAt: counters.reconciliation.lastAt,
    lastFailureAt: counters.reconciliation.lastFailureAt,
    passes: counters.reconciliation.count,
  },
  startedAt: counters.startedAt,
  watcher: publicWatcher(counters, watcher),
});

export { makeEventLoopCounters, mark, markReconciliation, readEventLoopDiagnostics };
export type { EngineEventLoopDiagnostics, EventLoopCounters };
