import type { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { expect } from 'vitest';

import type { CodexServerRequest } from '../src/codex/server-request-registry';
import {
  makeScheduleEngineHome,
  type OpenedEngine,
  type ScheduleEngineHome,
} from './schedule-engine-integration-fixture';

const THREAD_ID = 'thread-new';
const SETUP_TURN_ID = 'integration-turn-1';

interface ScheduleSeed {
  readonly callId: string;
  readonly oneShotAt: string;
  readonly rrule?: string;
}

interface ScheduledRunRow {
  readonly inbound_message_id: string;
  readonly logical_turn_id: null | string;
  readonly schedule_id: string;
  readonly scheduled_for: string;
  readonly state: string;
}

const count = (database: Database, table: string, where = '1 = 1'): number =>
  database
    .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .get()?.count ?? 0;

const createRequest = (seed: ScheduleSeed, index: number): CodexServerRequest => ({
  id: index,
  method: 'item/tool/call',
  params: {
    arguments: {
      oneShotAt: seed.oneShotAt,
      prompt: `integration-task-${seed.callId}`,
      ...(seed.rrule === undefined ? {} : { rrule: seed.rrule }),
      timezone: 'UTC',
    },
    callId: seed.callId,
    namespace: 'schedule',
    threadId: THREAD_ID,
    tool: 'create',
    turnId: SETUP_TURN_ID,
  },
});

const provision = Effect.fn('Test.provisionSchedules')(function* provisionSchedules(
  home: ScheduleEngineHome,
  seeds: readonly ScheduleSeed[],
) {
  const gate = Promise.withResolvers<undefined>();
  const opened = yield* home.open({
    behavior: { finalAnswer: 'setup complete', gate: gate.promise },
  });
  home.push('configure integration schedules');
  yield* opened.engine.pollOnce;
  expect(opened.trace.turnsStarted).toStrictEqual([SETUP_TURN_ID]);
  expect(count(opened.database, 'codex_attempts', "state = 'Accepted'")).toBe(1);
  for (const [index, seed] of seeds.entries()) {
    opened.publish(createRequest(seed, index + 1));
  }
  expect(opened.trace.responses).toHaveLength(seeds.length);
  for (const response of opened.trace.responses) {
    expect(response.result).toMatchObject({ success: true });
  }
  gate.resolve();
  yield* opened.awaitTurnsCompleted(1);
  yield* opened.engine.drain;
  expect(count(opened.database, 'logical_turns', "state = 'Running'")).toBe(0);
  yield* opened.close;
  return home.sent.length;
});

const runRows = (database: Database): readonly ScheduledRunRow[] =>
  database
    .query<ScheduledRunRow, []>(
      `SELECT schedule_id, scheduled_for, state, inbound_message_id, logical_turn_id
       FROM scheduled_runs ORDER BY scheduled_for`,
    )
    .all();

const stop = (
  opened: OpenedEngine,
  fiber: Fiber.Fiber<never, unknown>,
): Effect.Effect<void, unknown> => Fiber.interrupt(fiber).pipe(Effect.andThen(opened.close));

const start = Effect.fn('Test.startScheduleEngine')(function* startScheduleEngine(
  opened: OpenedEngine,
) {
  const fiber = yield* opened.engine.run.pipe(Effect.forkDetach({ startImmediately: true }));
  yield* Effect.yieldNow;
  yield* TestClock.adjust(0);
  return fiber;
});

it.effect('delivers one overdue scheduled turn exactly once across two restarts', () =>
  Effect.gen(function* durableOneShot() {
    const home = makeScheduleEngineHome();
    try {
      const baseline = yield* provision(home, [
        { callId: 'one-shot', oneShotAt: '2026-07-19T12:05:00.000Z' },
      ]);
      home.advanceTo('2026-07-19T12:10:00.000Z');
      const due = yield* home.open({ behavior: { finalAnswer: 'scheduled completion' } });
      const dueFiber = yield* start(due);
      yield* due.awaitTurnsCompleted(1);
      yield* due.engine.drain;
      expect(runRows(due.database)).toHaveLength(1);
      expect(runRows(due.database)[0]?.state).toBe('Completed');
      expect(home.sent).toHaveLength(baseline + 1);
      const [run] = runRows(due.database);
      const completedRun = run?.logical_turn_id === null ? undefined : run;
      if (completedRun === undefined) {
        throw new Error('expected a completed scheduled run');
      }
      const inbound = due.database
        .query<{ id: string; source_id: string; source_kind: string }, [string]>(
          'SELECT id, source_id, source_kind FROM inbound_messages WHERE id = ?',
        )
        .get(completedRun.inbound_message_id);
      expect(inbound).toStrictEqual({
        id: completedRun.inbound_message_id,
        source_id: completedRun.inbound_message_id.replace('schedule-inbound', 'schedule-run'),
        source_kind: 'ScheduleRun',
      });
      expect(
        count(
          due.database,
          'outbound_messages',
          `logical_turn_id = '${completedRun.logical_turn_id}' AND message_kind = 'Final'`,
        ),
      ).toBe(1);
      const stableInboundId = completedRun.inbound_message_id;
      yield* stop(due, dueFiber);

      const reconciled = yield* home.open();
      const reconciliationFiber = yield* start(reconciled);
      const scansBeforeReconciliation = reconciled.inboxScans();
      yield* TestClock.adjust('10 millis');
      yield* reconciled.awaitInboxScans(scansBeforeReconciliation + 1);
      yield* Effect.yieldNow;
      expect(reconciled.engine.readEventLoopDiagnostics().reconciliation.passes).toBeGreaterThan(0);
      expect(runRows(reconciled.database)).toMatchObject([
        { inbound_message_id: stableInboundId, state: 'Completed' },
      ]);
      expect(home.sent).toHaveLength(baseline + 1);
      expect(count(reconciled.database, 'outbound_messages', "message_kind = 'Final'")).toBe(2);
      yield* stop(reconciled, reconciliationFiber);
    } finally {
      home.remove();
    }
  }),
);

it.effect('serializes multiple due tasks and runs only the latest missed recurrence', () =>
  Effect.gen(function* serializedDueTasks() {
    const home = makeScheduleEngineHome();
    try {
      const baseline = yield* provision(home, [
        { callId: 'first-once', oneShotAt: '2026-07-19T12:05:00.000Z' },
        { callId: 'second-once', oneShotAt: '2026-07-19T12:06:00.000Z' },
        { callId: 'daily', oneShotAt: '2026-07-19T12:07:00.000Z', rrule: 'FREQ=DAILY' },
      ]);
      home.advanceTo('2026-07-22T12:30:00.000Z');
      const gate = Promise.withResolvers<undefined>();
      const opened = yield* home.open({
        behavior: { finalAnswer: 'serialized completion', gate: gate.promise },
      });
      const fiber = yield* start(opened);
      yield* opened.awaitTurnsStarted(1);
      expect(runRows(opened.database).map(({ state }) => state)).toStrictEqual([
        'Running',
        'Enqueued',
        'Enqueued',
      ]);
      expect(opened.trace.turnsStarted).toHaveLength(1);
      yield* TestClock.adjust('3 seconds');
      expect(runRows(opened.database).map(({ state }) => state)).toStrictEqual([
        'Running',
        'Running',
        'Running',
      ]);
      expect(opened.trace.steers).toHaveLength(1);
      gate.resolve();
      yield* opened.awaitTurnsCompleted(1);
      yield* opened.engine.drain;
      expect(runRows(opened.database).map(({ state }) => state)).toStrictEqual([
        'Completed',
        'Completed',
        'Completed',
      ]);
      expect(opened.trace.turnsStarted).toHaveLength(1);
      expect(home.sent).toHaveLength(baseline + 1);
      expect(
        runRows(opened.database).filter(
          ({ scheduled_for: scheduledFor }) => scheduledFor === '2026-07-22T12:07:00.000Z',
        ),
      ).toHaveLength(1);
      expect(count(opened.database, 'scheduled_runs')).toBe(3);
      yield* stop(opened, fiber);
    } finally {
      home.remove();
    }
  }),
);
