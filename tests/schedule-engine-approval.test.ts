import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { expect } from 'vitest';

import type { CodexServerRequest } from '../src/codex/server-request-registry';
import { ConversationMismatchError } from '../src/errors';
import {
  makeScheduleEngineHome,
  type OpenedEngine,
  type ScheduleEngineHome,
} from './schedule-engine-integration-fixture';

const THREAD_ID = 'thread-new';
const SETUP_TURN_ID = 'integration-turn-1';
const DUE_TURN_ID = 'integration-turn-2';

const scheduleRequest = (): CodexServerRequest => ({
  id: 1,
  method: 'item/tool/call',
  params: {
    arguments: {
      oneShotAt: '2026-07-19T12:05:00.000Z',
      prompt: 'approval integration task',
      timezone: 'UTC',
    },
    callId: 'approval-once',
    namespace: 'schedule',
    threadId: THREAD_ID,
    tool: 'create',
    turnId: SETUP_TURN_ID,
  },
});

const approvalRequest = (id: number): CodexServerRequest => ({
  id,
  method: 'item/commandExecution/requestApproval',
  params: {
    availableDecisions: ['accept', 'decline'],
    command: `curl https://example.com/${String(id)}`,
    cwd: '/workspace',
    itemId: `item-${String(id)}`,
    reason: 'scheduled integration approval',
    startedAtMs: Date.parse('2026-07-19T12:10:00.000Z'),
    threadId: THREAD_ID,
    turnId: DUE_TURN_ID,
  },
});

const provision = Effect.fn('Test.provisionApprovalSchedule')(function* provisionApprovalSchedule(
  home: ScheduleEngineHome,
) {
  const gate = Promise.withResolvers<undefined>();
  const opened = yield* home.open({ behavior: { gate: gate.promise } });
  home.push('configure approval schedule');
  yield* opened.engine.pollOnce;
  expect(opened.trace.turnsStarted).toStrictEqual([SETUP_TURN_ID]);
  opened.publish(scheduleRequest());
  expect(opened.trace.responses).toMatchObject([{ id: 1, result: { success: true } }]);
  gate.resolve();
  yield* opened.awaitTurnsCompleted(1);
  yield* opened.engine.drain;
  yield* opened.close;
});

const start = Effect.fn('Test.startApprovalEngine')(function* startApprovalEngine(
  opened: OpenedEngine,
) {
  const fiber = yield* opened.engine.run.pipe(Effect.forkDetach({ startImmediately: true }));
  yield* Effect.yieldNow;
  yield* TestClock.adjust(0);
  return fiber;
});

const stateOf = (opened: OpenedEngine, rpcId: number): string | null =>
  opened.database
    .query<{ state: string }, [string]>(
      'SELECT state FROM approval_requests WHERE rpc_request_id_json = ?',
    )
    .get(JSON.stringify(rpcId))?.state ?? null;

it.effect('waits for conversation recovery and routes scheduled approvals through yes and no', () =>
  Effect.gen(function* unavailableApprovalRecovery() {
    const home = makeScheduleEngineHome();
    try {
      yield* provision(home);
      home.advanceTo('2026-07-19T12:10:00.000Z');
      let available = false;
      const gate = Promise.withResolvers<undefined>();
      const opened = yield* home.open({
        behavior: { finalAnswer: 'approval completion', gate: gate.promise },
        probe: () =>
          available
            ? Effect.void
            : Effect.fail(
                new ConversationMismatchError({
                  chatGuid: 'integration-chat',
                  handle: 'integration-handle',
                  message: 'integration conversation unavailable',
                }),
              ),
        validationIntervalMs: 0,
      });
      const fiber = yield* start(opened);
      expect(
        opened.database
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM scheduled_runs')
          .get(),
      ).toStrictEqual({ count: 0 });

      available = true;
      expect(yield* opened.conversation.revalidate(home.now(), 'DatabaseChanged')).toBe(true);
      yield* TestClock.adjust('10 millis');
      yield* opened.awaitTurnsStarted(1);
      expect(opened.trace.turnsStarted).toStrictEqual([DUE_TURN_ID]);

      let expectedSent = home.sent.length + 1;
      opened.publish(approvalRequest(101));
      yield* home.awaitSent(expectedSent);
      expect(stateOf(opened, 101)).toBe('Pending');
      home.push('/yes');
      yield* opened.engine.pollOnce;
      expect(stateOf(opened, 101)).toBe('Approved');

      expectedSent = home.sent.length + 1;
      opened.publish(approvalRequest(102));
      yield* home.awaitSent(expectedSent);
      expect(stateOf(opened, 102)).toBe('Pending');
      home.push('/no');
      yield* opened.engine.pollOnce;
      expect(stateOf(opened, 102)).toBe('Denied');
      expect(opened.trace.responses).toEqual(
        expect.arrayContaining([
          { id: 101, result: { decision: 'accept' } },
          { id: 102, result: { decision: 'decline' } },
        ]),
      );

      gate.resolve();
      yield* opened.awaitTurnsCompleted(1);
      yield* opened.engine.drain;
      yield* Fiber.interrupt(fiber);
      yield* opened.close;
    } finally {
      home.remove();
    }
  }),
);
