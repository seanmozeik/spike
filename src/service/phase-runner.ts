import { Duration, Effect, Result, type Semaphore } from 'effect';

import { runSchedulePhase, scheduleNextWake } from '../schedule/phase';
import type { SchedulerController } from '../scheduler/controller';
import { report, type EngineContext } from './context';
import { markReconciliation } from './event-loop-diagnostics';
import { pollApprovalEvents } from './ingestion-phase';
import {
  runAccountObservationPhase,
  runRedactionPhase,
  scheduleMaintenance,
} from './maintenance-phase';
import { processRecovery } from './recovery-phase';
import type { EngineWakeKind } from './wake';

const DEFAULT_RECONCILE_INTERVAL_MS = Duration.toMillis('1 minute');
const DEFAULT_PHASE_RETRY_MS = Duration.toMillis('1 second');
const APPROVAL_RETRY_TIMER = 'approval-retry';
const INGESTION_RETRY_TIMER = 'ingestion-retry';
const RECOVERY_RETRY_TIMER = 'recovery-retry';
const RECONCILE_TIMER = 'messages-reconcile';
const DATABASE_REPLACEMENT_RETRY_TIMER = 'database-replacement-retry';

const runRetriablePhase = Effect.fn('SpikeEngine.runRetriablePhase')(function* runRetriablePhase(
  context: EngineContext,
  retryTimer: string,
  retryWake: EngineWakeKind,
  phase: Effect.Effect<void, unknown>,
) {
  const result = yield* Effect.result(phase);
  if (Result.isSuccess(result)) {
    yield* context.wakes.cancel(retryTimer);
    return true;
  }
  report(context, result.failure);
  yield* context.wakes.scheduleAfter(
    retryTimer,
    retryWake,
    context.options.phaseRetryMs ?? DEFAULT_PHASE_RETRY_MS,
  );
  return false;
});

const scheduleReconciliation = (context: EngineContext): Effect.Effect<void> =>
  context.wakes.scheduleAfter(
    RECONCILE_TIMER,
    'Reconcile',
    context.options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
  );

const prepareDatabaseReplacement = (context: EngineContext): Effect.Effect<boolean> =>
  Effect.gen(function* refreshMessagesConnections() {
    const refreshed = yield* Effect.result(
      context.options.conversation.revalidate(context.now(), 'DatabaseChanged'),
    );
    const available = Result.isSuccess(refreshed) && refreshed.success;
    if (available) {
      yield* context.wakes.cancel(DATABASE_REPLACEMENT_RETRY_TIMER);
      return true;
    }
    if (Result.isFailure(refreshed)) {
      report(context, refreshed.failure);
    }
    yield* context.wakes.scheduleAfter(
      DATABASE_REPLACEMENT_RETRY_TIMER,
      'DatabaseReplaced',
      context.options.phaseRetryMs ?? DEFAULT_PHASE_RETRY_MS,
    );
    return false;
  });

const runApprovalPhase = (context: EngineContext): Effect.Effect<boolean> =>
  runRetriablePhase(context, APPROVAL_RETRY_TIMER, 'Approval', pollApprovalEvents(context));

const runExplicitRecovery = (
  context: EngineContext,
  controller: SchedulerController,
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function* recoverForExplicitPoll() {
    const result = yield* Effect.result(processRecovery(context, controller));
    if (Result.isFailure(result)) {
      report(context, result.failure);
      yield* context.wakes.scheduleAfter(
        RECOVERY_RETRY_TIMER,
        'Recovery',
        context.options.phaseRetryMs ?? DEFAULT_PHASE_RETRY_MS,
      );
      return yield* Effect.fail(result.failure);
    }
    if (!result.success) {
      yield* context.wakes.scheduleAfter(
        RECOVERY_RETRY_TIMER,
        'Recovery',
        context.options.phaseRetryMs ?? DEFAULT_PHASE_RETRY_MS,
      );
      return false;
    }
    yield* context.wakes.cancel(RECOVERY_RETRY_TIMER);
    return true;
  });

const runExplicitPoll = (
  context: EngineContext,
  controller: SchedulerController,
  ingestion: Effect.Effect<void, unknown>,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* explicitPoll() {
    yield* runAccountObservationPhase(context, controller);
    yield* runRedactionPhase(context);
    if (context.accountFailover.requested) {
      return;
    }
    if (!(yield* runExplicitRecovery(context, controller))) {
      return;
    }
    yield* runRetriablePhase(context, INGESTION_RETRY_TIMER, 'Messages', ingestion);
  });

const runMaintenanceWakes = (
  context: EngineContext,
  controller: SchedulerController,
  wakes: ReadonlySet<EngineWakeKind>,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* maintainForWakes() {
    if (wakes.has('AccountObservation')) {
      yield* runAccountObservationPhase(context, controller);
    }
    if (wakes.has('Redaction')) {
      yield* runRedactionPhase(context);
    }
  });

const runRecoveryWake = (
  context: EngineContext,
  controller: SchedulerController,
  wakes: ReadonlySet<EngineWakeKind>,
  databaseReplaced: boolean,
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function* recoverForWakes() {
    if (!wakes.has('Recovery') && !wakes.has('Reconcile') && !databaseReplaced) {
      return context.schedulerReady.value;
    }
    const result = yield* Effect.result(processRecovery(context, controller));
    const recovered = Result.isSuccess(result) && result.success;
    if (recovered) {
      yield* context.wakes.cancel(RECOVERY_RETRY_TIMER);
    } else {
      if (Result.isFailure(result)) {
        report(context, result.failure);
      }
      yield* context.wakes.scheduleAfter(
        RECOVERY_RETRY_TIMER,
        'Recovery',
        context.options.phaseRetryMs ?? DEFAULT_PHASE_RETRY_MS,
      );
    }
    if (context.turnTerminals.pending.size > 0) {
      yield* context.wakes.scheduleAfter(
        RECOVERY_RETRY_TIMER,
        'Recovery',
        context.options.phaseRetryMs ?? DEFAULT_PHASE_RETRY_MS,
      );
    }
    return recovered;
  });

const runIngestionWake = (
  context: EngineContext,
  ingestion: Effect.Effect<void, unknown>,
  trustedIngestion: Effect.Effect<void, unknown>,
  wakes: ReadonlySet<EngineWakeKind>,
  databaseReplaced: boolean,
  recoveryReady: boolean,
): Effect.Effect<boolean> =>
  Effect.gen(function* ingestForWakes() {
    if (!wakes.has('Messages') && !wakes.has('Reconcile') && !databaseReplaced) {
      return true;
    }
    const processed = yield* runRetriablePhase(
      context,
      INGESTION_RETRY_TIMER,
      'Messages',
      recoveryReady ? ingestion : trustedIngestion,
    );
    if (recoveryReady) {
      return processed;
    }
    yield* context.wakes.scheduleAfter(
      INGESTION_RETRY_TIMER,
      'Messages',
      context.options.phaseRetryMs ?? DEFAULT_PHASE_RETRY_MS,
    );
    return false;
  });

const finishBlockedReplacement = (
  context: EngineContext,
  wakes: ReadonlySet<EngineWakeKind>,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* completeBlockedReplacement() {
    if (wakes.has('Approval')) {
      yield* runApprovalPhase(context);
    }
    if (wakes.has('Reconcile')) {
      markReconciliation(context.loopDiagnostics, context.now(), true);
      yield* scheduleReconciliation(context);
    }
  });

const runWakeBatch = Effect.fn('SpikeEngine.runWakeBatch')(function* runWakeBatch(
  context: EngineContext,
  controller: SchedulerController,
  ingestion: Effect.Effect<void, unknown>,
  trustedIngestion: Effect.Effect<void, unknown>,
  wakes: ReadonlySet<EngineWakeKind>,
) {
  const reconciliation = wakes.has('Reconcile');
  yield* runMaintenanceWakes(context, controller, wakes);
  const databaseReplaced = wakes.has('DatabaseReplaced');
  if (databaseReplaced && !(yield* prepareDatabaseReplacement(context))) {
    yield* finishBlockedReplacement(context, wakes);
    return;
  }
  const recovered = yield* runRecoveryWake(context, controller, wakes, databaseReplaced);
  if (wakes.has('ScheduleDue')) {
    const conversationAvailable = yield* context.options.conversation.isAvailable;
    if (recovered && context.schedulerReady.value && conversationAvailable) {
      const scheduled = yield* Effect.result(runSchedulePhase(context, controller));
      if (Result.isFailure(scheduled)) {
        report(context, scheduled.failure);
      }
    } else {
      context.wakes.signal('Recovery');
      yield* scheduleNextWake(context, context.options.phaseRetryMs ?? DEFAULT_PHASE_RETRY_MS);
    }
  }
  if (wakes.has('Approval')) {
    yield* runApprovalPhase(context);
  }
  const ingested = yield* runIngestionWake(
    context,
    ingestion,
    trustedIngestion,
    wakes,
    databaseReplaced,
    recovered,
  );
  if (reconciliation) {
    markReconciliation(context.loopDiagnostics, context.now(), !recovered || !ingested);
    yield* scheduleReconciliation(context);
  }
});

const makeEngineCycle = (
  context: EngineContext,
  controller: SchedulerController,
  ingestion: Effect.Effect<void, unknown>,
  trustedIngestion: Effect.Effect<void, unknown>,
  phases: Semaphore.Semaphore,
): Effect.Effect<never> => {
  const wakeCycle = Effect.gen(function* processWakeBatch() {
    const batch = yield* context.wakes.take;
    const result = yield* Effect.result(
      phases.withPermit(runWakeBatch(context, controller, ingestion, trustedIngestion, batch)),
    );
    if (Result.isFailure(result)) {
      report(context, result.failure);
    }
  });
  return Effect.all([scheduleReconciliation(context), scheduleMaintenance(context)], {
    concurrency: 'unbounded',
    discard: true,
  }).pipe(Effect.andThen(Effect.forever(wakeCycle)));
};

export { makeEngineCycle, runExplicitPoll };
