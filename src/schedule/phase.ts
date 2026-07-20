import { createHash, randomUUID } from 'node:crypto';

import { Effect, Result } from 'effect';

import { GenerationId, InboundMessageId, LogicalTurnId } from '../domain/ids';
import type { SchedulerController } from '../scheduler/controller';
import type { SchedulerEvent } from '../scheduler/model';
import { captureAccountFailure } from '../service/account-failover';
import { report, type EngineContext } from '../service/context';
import { repairDispatchFailure } from '../service/dispatch-repair';
import type { DueSchedule } from './model';
import { recurrenceCursor } from './recurrence';

const SCHEDULE_TIMER = 'next-schedule-due';
const DEFAULT_PHASE_RETRY_MS = 1000;

const stableId = (kind: string, schedule: DueSchedule, scheduledFor: Date): string => {
  const digest = createHash('sha256')
    .update(`${schedule.id}\0${scheduledFor.toISOString()}`)
    .digest('hex');
  return `${kind}:${digest}`;
};

const occurrence = (
  schedule: DueSchedule,
  now: Date,
): { readonly next: Date | null; readonly scheduledFor: Date } => {
  if (schedule.rrule === null) {
    return { next: null, scheduledFor: schedule.oneShotAt };
  }
  const cursor = recurrenceCursor(schedule.rrule, schedule.oneShotAt, schedule.timezone, now);
  if (cursor.due === null) {
    throw new Error('due recurrence has no occurrence at or before now');
  }
  return { next: cursor.next, scheduledFor: cursor.due };
};

const dueEvent = (
  schedule: DueSchedule,
  now: Date,
): Extract<SchedulerEvent, { kind: 'ScheduleDue' }> => {
  const { next, scheduledFor } = occurrence(schedule, now);
  const runId = stableId('schedule-run', schedule, scheduledFor);
  return {
    expectedDueAt: schedule.expectedDueAt,
    expectedRevision: schedule.expectedRevision,
    kind: 'ScheduleDue',
    message: {
      attachments: [],
      id: InboundMessageId.make(stableId('schedule-inbound', schedule, scheduledFor)),
      receivedAt: now,
      text: schedule.prompt,
    },
    newGenerationId: GenerationId.make(randomUUID()),
    nextDueAt: next,
    nextLogicalTurnId: LogicalTurnId.make(randomUUID()),
    runId,
    scheduleId: schedule.id,
    scheduledFor,
  };
};

const scheduleNextWake = (
  context: EngineContext,
  minimumDelayMs = 0,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* armNextSchedule() {
    const nextDue = yield* context.scheduleJournal.nextDueAt;
    if (nextDue === null) {
      yield* context.wakes.cancel(SCHEDULE_TIMER);
      return;
    }
    yield* context.wakes.scheduleAfter(
      SCHEDULE_TIMER,
      'ScheduleDue',
      Math.max(minimumDelayMs, nextDue.getTime() - context.now().getTime()),
    );
  });

const repairScheduleDispatch = Effect.fn('SpikeEngine.repairScheduleDispatch')(
  function* repairScheduleDispatch(
    context: EngineContext,
    controller: SchedulerController,
    event: Extract<SchedulerEvent, { kind: 'ScheduleDue' }>,
    error: unknown,
  ) {
    const after = yield* controller.snapshot;
    if (yield* captureAccountFailure(context, controller, error)) {
      return;
    }
    const repaired = yield* repairDispatchFailure(
      context,
      after,
      event.nextLogicalTurnId,
      null,
      error,
    );
    if (!repaired && after.pool.some(({ id }) => id === event.message.id)) {
      context.wakes.signal('Recovery');
    }
  },
);

const rearmSchedulePhase = Effect.fn('SpikeEngine.rearmSchedulePhase')(function* rearmSchedulePhase(
  context: EngineContext,
  retryDelay: number,
) {
  const armed = yield* Effect.result(scheduleNextWake(context, retryDelay));
  if (Result.isFailure(armed)) {
    report(context, armed.failure);
  }
});

const runSchedulePhase = (
  context: EngineContext,
  controller: SchedulerController,
): Effect.Effect<void, unknown> => {
  const dispatch = Effect.gen(function* dispatchDueSchedules() {
    let schedule = yield* context.scheduleJournal.due(context.now());
    while (schedule !== null) {
      const event = dueEvent(schedule, context.now());
      yield* controller
        .dispatch(event)
        .pipe(
          Effect.catch((error) =>
            repairScheduleDispatch(context, controller, event, error).pipe(
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
      schedule = yield* context.scheduleJournal.due(context.now());
    }
  });
  return Effect.result(dispatch).pipe(
    Effect.flatMap((phase) => {
      const retryDelay = Result.isFailure(phase)
        ? (context.options.phaseRetryMs ?? DEFAULT_PHASE_RETRY_MS)
        : 0;
      const finish = Result.isFailure(phase) ? Effect.fail(phase.failure) : Effect.void;
      return rearmSchedulePhase(context, retryDelay).pipe(Effect.andThen(finish));
    }),
  );
};

export { dueEvent, runSchedulePhase, scheduleNextWake };
