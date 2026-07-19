import { Duration, Effect, Result } from 'effect';

import { observeAccount } from '../codex/account-observation';
import { WaitingForCapacity } from '../errors';
import type { SchedulerController } from '../scheduler/controller';
import { requestPendingAccountFailover } from './account-failover';
import { report, type EngineContext } from './context';

const ACCOUNT_OBSERVATION_TIMER = 'account-observation';
const REDACTION_TIMER = 'payload-redaction';
const DEFAULT_ACCOUNT_OBSERVATION_INTERVAL_MS = Duration.toMillis('1 minute');
const DEFAULT_REDACTION_INTERVAL_MS = Duration.toMillis('6 hours');
const DEFAULT_MAINTENANCE_RETRY_MS = Duration.toMillis('1 second');
const RETENTION_DAYS = 30;
const MILLISECONDS_PER_DAY = 86_400_000;

const accountObservationInterval = (context: EngineContext): number =>
  context.options.accountObservationIntervalMs ?? DEFAULT_ACCOUNT_OBSERVATION_INTERVAL_MS;

const redactionInterval = (context: EngineContext): number =>
  context.options.redactionIntervalMs ?? DEFAULT_REDACTION_INTERVAL_MS;

const scheduleAccountObservation = (context: EngineContext): Effect.Effect<void> =>
  context.wakes.scheduleAfter(
    ACCOUNT_OBSERVATION_TIMER,
    'AccountObservation',
    accountObservationInterval(context),
  );

const scheduleRedaction = (context: EngineContext): Effect.Effect<void> =>
  context.wakes.scheduleAfter(REDACTION_TIMER, 'Redaction', redactionInterval(context));

const redactAt = Effect.fn('SpikeEngine.redactAt')(function* redactAt(
  context: EngineContext,
  at: Date,
) {
  return yield* context.journal.redactTerminalPayloads(
    new Date(at.getTime() - RETENTION_DAYS * MILLISECONDS_PER_DAY),
    at,
  );
});

const redactNow = Effect.fn('SpikeEngine.redactNow')(function* redactNow(
  context: EngineContext,
  at: Date,
) {
  const count = yield* redactAt(context, at);
  context.lastRedactionAt.value = at;
  return count;
});

const runRedactionPhase = Effect.fn('SpikeEngine.runRedactionPhase')(function* runRedactionPhase(
  context: EngineContext,
) {
  if (
    context.now().getTime() - context.lastRedactionAt.value.getTime() <
    redactionInterval(context)
  ) {
    yield* scheduleRedaction(context);
    return;
  }
  const result = yield* Effect.result(redactNow(context, context.now()));
  if (Result.isFailure(result)) {
    report(context, result.failure);
    yield* context.wakes.scheduleAfter(
      REDACTION_TIMER,
      'Redaction',
      context.options.phaseRetryMs ?? DEFAULT_MAINTENANCE_RETRY_MS,
    );
    return;
  }
  yield* scheduleRedaction(context);
});

const runAccountObservationPhase = Effect.fn('SpikeEngine.runAccountObservationPhase')(
  function* runAccountObservationPhase(context: EngineContext, controller: SchedulerController) {
    if (
      !context.options.runtime.accountId.startsWith('provider:') &&
      context.accountFailover.pending === null &&
      context.now().getTime() - context.lastAccountObservationAt.value.getTime() >=
        accountObservationInterval(context)
    ) {
      const at = context.now();
      context.lastAccountObservationAt.value = at;
      const result = yield* Effect.result(
        observeAccount(context.options.runtime, context.codexJournal, at),
      );
      if (Result.isFailure(result)) {
        report(context, result.failure);
      } else if (result.success.mode === 'Capacity') {
        context.accountFailover.pending = new WaitingForCapacity({
          resetAt: result.success.resetAt,
        });
        yield* requestPendingAccountFailover(context, controller);
      }
    }
    yield* scheduleAccountObservation(context);
  },
);

const scheduleMaintenance = (context: EngineContext): Effect.Effect<void> =>
  Effect.all([scheduleAccountObservation(context), scheduleRedaction(context)], {
    concurrency: 'unbounded',
    discard: true,
  });

export { redactNow, runAccountObservationPhase, runRedactionPhase, scheduleMaintenance };
