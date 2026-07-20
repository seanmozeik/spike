import { Effect, Fiber, Semaphore } from 'effect';

import { makeAttachmentStagingPolicy } from '../attachments/staging-policy';
import { MessagesRowId } from '../domain/ids';
import { makeAttachmentDiagnostic } from '../journal/attachment-diagnostic';
import { makeCodexJournal } from '../journal/codex-journal';
import { makeSchedulerJournal } from '../journal/scheduler-journal';
import { makeJournal } from '../journal/service';
import { makeFailureLog } from '../logging/failure-log';
import type { MessagesWatcher, MessagesWatcherDiagnostics } from '../messages-watcher';
import { makeScheduleJournal } from '../schedule/journal';
import { systemScheduleRequestScheduler } from '../schedule/pending-tool-calls';
import { scheduleNextWake } from '../schedule/phase';
import { makeScheduleServerRequests } from '../schedule/server-requests';
import { makeSchedulerController, type SchedulerController } from '../scheduler/controller';
import type { SchedulerState } from '../scheduler/model';
import {
  type AccountFailure,
  report,
  type EngineContext,
  type SpikeEngineOptions,
} from './context';
import { initializeConversation } from './conversation-lifecycle';
import {
  makeEventLoopCounters,
  mark,
  readEventLoopDiagnostics,
  type EngineEventLoopDiagnostics,
} from './event-loop-diagnostics';
import { processIngestion, processTrustedIngestion } from './ingestion-phase';
import { redactNow } from './maintenance-phase';
import { makeEngineCycle, runExplicitPoll } from './phase-runner';
import { makeTurnTerminalQueue } from './turn-terminal-model';
import { makePorts } from './turns';
import { makeDebouncedSignal, makeEngineWakeHub, type EngineWakeKind } from './wake';

interface SpikeEngine {
  readonly accountUnavailable: Effect.Effect<AccountFailure>;
  readonly close: () => void;
  readonly drain: Effect.Effect<void>;
  readonly pollOnce: Effect.Effect<void, unknown>;
  readonly quiesce: () => void;
  readonly readEventLoopDiagnostics: () => EngineEventLoopDiagnostics;
  readonly redactNow: (now: Date) => Effect.Effect<number, unknown>;
  readonly run: Effect.Effect<never>;
  readonly scanFloor: Effect.Effect<MessagesRowId>;
  readonly shutdown: Effect.Effect<void, unknown>;
  readonly snapshot: Effect.Effect<SchedulerState>;
  readonly watcherDiagnostics: Effect.Effect<MessagesWatcherDiagnostics | null>;
}

const DEFAULT_MESSAGES_DEBOUNCE_MS = 25;

const beginQuiesce = (context: EngineContext): readonly Fiber.Fiber<void, unknown>[] => {
  context.schedulingClosed.value = true;
  context.options.conversation.close();
  for (const timer of context.watcherDebounceTimers) {
    clearTimeout(timer);
  }
  context.watcherDebounceTimers.clear();
  return [...context.scheduledFibers];
};

const quiesceEngine = (context: EngineContext): void => {
  for (const fiber of beginQuiesce(context)) {
    fiber.interruptUnsafe();
  }
};

const closeEngine = (context: EngineContext): void => {
  context.closing.value = true;
  quiesceEngine(context);
};

const makeContext = (
  options: SpikeEngineOptions,
  now: () => Date,
  wakes: EngineContext['wakes'],
): EngineContext => {
  const journal = makeJournal(
    options.database,
    { chatGuid: options.chatGuid, handle: options.handle },
    {
      attachmentStaging: {
        sourceRoot: options.attachmentSourceRoot,
        stagingBoundary: options.attachmentStagingBoundary,
        stagingRoot: options.attachmentStagingRoot,
      },
    },
  );
  return {
    accountFailover: { pending: null, requested: false, signal: Promise.withResolvers() },
    approval: null,
    attachmentStaging: makeAttachmentStagingPolicy({
      diagnostic: makeAttachmentDiagnostic(options.database),
      stage: journal.stagePendingAttachments,
    }),
    closing: { value: false },
    codexJournal: makeCodexJournal(options.database),
    controllerReady: Promise.withResolvers<SchedulerController>(),
    conversationReady: { value: false },
    failureLog: options.failureLog ?? makeFailureLog(),
    journal,
    lastAccountObservationAt: { value: new Date(0) },
    lastRedactionAt: { value: now() },
    loopDiagnostics: makeEventLoopCounters(now()),
    monitors: new Map(),
    now,
    options,
    pendingScanFloor: { value: MessagesRowId.make(0) },
    recoveryPending: { value: true },
    scheduleJournal: makeScheduleJournal(options.database),
    scheduleRequests: null,
    scheduledFibers: new Set(),
    schedulerJournal: makeSchedulerJournal(options.database),
    schedulerReady: { value: false },
    schedulingClosed: { value: false },
    turnTerminals: makeTurnTerminalQueue(),
    wakes,
    watcherDebounceTimers: new Set(),
  };
};

const openEngineWatcher = (
  context: EngineContext,
  now: () => Date,
): Effect.Effect<MessagesWatcher | null, unknown> => {
  if (context.options.watchMessages === undefined) {
    return Effect.succeed(null);
  }
  let pendingWake: EngineWakeKind = 'Messages';
  const signalDirty = makeDebouncedSignal(
    () => {
      const wake = pendingWake;
      pendingWake = 'Messages';
      mark(context.loopDiagnostics.filesystemWakes, context.now());
      context.wakes.signal(wake);
    },
    context.watcherDebounceTimers,
    context.options.messagesDebounceMs ?? DEFAULT_MESSAGES_DEBOUNCE_MS,
  );
  return context.options.watchMessages({
    now,
    onError: (error) => {
      mark(context.loopDiagnostics.watcherFailures, context.now());
      report(context, error);
    },
    onEvent: (event) => {
      mark(context.loopDiagnostics.filesystemEvents, context.now());
      if (event.kind === 'DatabaseReplaced') {
        pendingWake = 'DatabaseReplaced';
      }
      signalDirty();
    },
  });
};

const assembleEngine = (
  context: EngineContext,
  controller: SchedulerController,
  phases: Semaphore.Semaphore,
  watcher: MessagesWatcher | null,
): SpikeEngine => {
  const ingestion = processIngestion(context, controller);
  const trustedIngestion = processTrustedIngestion(context, controller);
  const close = (): void => {
    watcher?.close();
    closeEngine(context);
  };
  return {
    accountUnavailable: Effect.promise(() => context.accountFailover.signal.promise),
    close,
    drain: Effect.promise(async () => {
      await Promise.all(context.monitors.values());
      await context.turnTerminals.tail;
    }),
    pollOnce: phases.withPermit(runExplicitPoll(context, controller, ingestion, trustedIngestion)),
    quiesce: (): void => {
      watcher?.close();
      quiesceEngine(context);
    },
    readEventLoopDiagnostics: (): EngineEventLoopDiagnostics =>
      readEventLoopDiagnostics(context.loopDiagnostics, watcher?.diagnostics() ?? null),
    redactNow: (at): Effect.Effect<number, unknown> => redactNow(context, at),
    run: makeEngineCycle(context, controller, ingestion, trustedIngestion, phases),
    scanFloor: Effect.sync(() => context.pendingScanFloor.value),
    shutdown: Effect.gen(function* shutdownEngine() {
      close();
      context.scheduleRequests?.close();
      context.scheduleRequests = null;
      const scheduled = [...context.scheduledFibers];
      yield* Fiber.interruptAll(scheduled);
      context.scheduledFibers.clear();
      yield* context.wakes.close;
      if (context.approval !== null) {
        yield* context.approval.close;
      }
    }),
    snapshot: controller.snapshot,
    watcherDiagnostics: Effect.sync(() => watcher?.diagnostics() ?? null),
  };
};

const loadAuditedSchedulerState = Effect.fn('SpikeEngine.loadAuditedSchedulerState')(
  function* loadAuditedSchedulerState(context: EngineContext, at: Date) {
    yield* context.journal.auditStagedAttachments;
    return yield* context.schedulerJournal.loadOrCreate(at);
  },
);

const makeSpikeEngine = Effect.fn('SpikeEngine.make')(function* makeSpikeEngine(
  options: SpikeEngineOptions,
) {
  const now = options.now ?? ((): Date => new Date());
  const wakes = yield* makeEngineWakeHub();
  const context = makeContext(options, now, wakes);
  context.scheduleRequests = makeScheduleServerRequests({
    database: options.database,
    journal: context.scheduleJournal,
    now,
    onError: (cause) => {
      report(context, cause);
    },
    onMutation: () => {
      wakes.signal('ScheduleDue');
    },
    pendingTimeoutMs: 30_000,
    runtime: options.runtime,
    scheduler: systemScheduleRequestScheduler,
  });
  const startupAvailable = yield* options.conversation.revalidate(now(), 'Startup');
  const initial = yield* loadAuditedSchedulerState(context, now());
  if (startupAvailable) {
    yield* initializeConversation(context);
  }
  const controller = yield* makeSchedulerController(
    initial,
    context.schedulerJournal,
    makePorts(context),
  );
  context.controllerReady.resolve(controller);
  const phases = yield* Semaphore.make(1);
  const watcher = yield* openEngineWatcher(context, now);
  wakes.signal('AccountObservation');
  wakes.signal('Recovery');
  wakes.signal('Messages');
  yield* scheduleNextWake(context);
  return assembleEngine(context, controller, phases, watcher);
});

export { makeSpikeEngine };
export type { SpikeEngine };
export type { SpikeEngineOptions } from './context';
