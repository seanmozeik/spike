import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { expect } from 'vitest';

import { canonicalInputFingerprint } from '../src/codex/reconcile';
import { inbound, makeEngineFixture, makeMigratedEngineFixture } from './engine-fixture';
import {
  seedVersionTenActiveAttempt,
  seedVersionTenSteerBacklog,
} from './version-ten-recovery-fixture';

const failStateTrigger = (name: string, state: 'Completed' | 'Failed'): string =>
  `CREATE TRIGGER ${name} BEFORE UPDATE OF state ON logical_turns
   WHEN NEW.state = '${state}'
   BEGIN SELECT RAISE(ABORT, 'forced ${state.toLowerCase()} persistence failure'); END`;

const failTerminalSchedulerSaveTrigger = (name: string): string =>
  `CREATE TRIGGER ${name} BEFORE UPDATE OF active_logical_turn_id ON scheduler_state
   WHEN OLD.active_logical_turn_id IS NOT NULL AND NEW.active_logical_turn_id IS NULL
   BEGIN SELECT RAISE(ABORT, 'forced scheduler state persistence failure'); END`;

const failAttemptCompletionTrigger = (name: string): string =>
  `CREATE TRIGGER ${name} BEFORE UPDATE OF state ON codex_attempts
   WHEN NEW.state = 'Completed'
   BEGIN SELECT RAISE(ABORT, 'forced attempt completion failure'); END`;

it.effect('does not fail model work when a local status reply cannot be delivered', () =>
  Effect.gen(function* isolatedControlFailure() {
    const gate = Promise.withResolvers<undefined>();
    const fixture = yield* makeEngineFixture({
      behavior: { deliveryFailure: 'transport unavailable', gate: gate.promise },
    });
    fixture.push(inbound(1, 'long request'));
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));

    fixture.push(inbound(2, '/status'));
    yield* fixture.engine.pollOnce;

    expect((yield* fixture.engine.snapshot).active).not.toBeNull();
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Running');
    expect(fixture.sent).toStrictEqual(['Spike ok · uptime 1m']);

    fixture.engine.close();
    gate.reject(new Error('stop closed monitor'));
    yield* fixture.engine.drain;
    fixture.remove();
  }),
);

it.effect('keeps delivered output completion-owned when attempt bookkeeping fails', () =>
  Effect.gen(function* completionRetry() {
    const gate = Promise.withResolvers<undefined>();
    const fixture = yield* makeEngineFixture({
      behavior: { finalAnswer: 'Completed answer.', gate: gate.promise },
    });
    fixture.push(inbound(1, 'request'));
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    fixture.database.run(failAttemptCompletionTrigger('force_attempt_complete_failure'));

    gate.resolve();
    yield* fixture.engine.drain;
    expect(fixture.sent).toStrictEqual(['Completed answer']);
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Running');
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM codex_attempts').get()
        ?.state,
    ).toBe('Accepted');

    fixture.database.run('DROP TRIGGER force_attempt_complete_failure');
    yield* fixture.engine.pollOnce;
    expect((yield* fixture.engine.snapshot).active).toBeNull();
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Completed');
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM codex_attempts').get()
        ?.state,
    ).toBe('Completed');
    expect(fixture.sent).toStrictEqual(['Completed answer']);
    fixture.engine.close();
    fixture.remove();
  }),
);

it.effect('atomically rolls back a failed scheduler-state save and converges on retry', () =>
  Effect.gen(function* failureRetry() {
    const fixture = yield* makeEngineFixture({ behavior: { startFailure: 'start unavailable' } });
    fixture.database.run(failTerminalSchedulerSaveTrigger('force_terminal_state_save_failure'));
    fixture.push(inbound(1, 'request'));
    yield* fixture.engine.pollOnce;

    expect(fixture.sent).toStrictEqual([]);
    const blocked = yield* fixture.engine.snapshot;
    expect(blocked.active).not.toBeNull();
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Running');
    expect(
      fixture.database
        .query<{ active_logical_turn_id: string | null }, []>(
          'SELECT active_logical_turn_id FROM scheduler_state WHERE singleton = 1',
        )
        .get()?.active_logical_turn_id,
    ).toBe(blocked.active?.logicalTurnId);

    fixture.database.run('DROP TRIGGER force_terminal_state_save_failure');
    yield* fixture.engine.pollOnce;
    const recovered = yield* fixture.engine.snapshot;
    expect(recovered.active).toBeNull();
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Failed');
    expect(
      fixture.database
        .query<{ active_logical_turn_id: string | null }, []>(
          'SELECT active_logical_turn_id FROM scheduler_state WHERE singleton = 1',
        )
        .get()?.active_logical_turn_id,
    ).toBeNull();
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM logical_turns')
        .get()?.count,
    ).toBe(1);
    expect(fixture.sent).toStrictEqual(['Spike hit an error: start unavailable']);
    fixture.engine.close();
    fixture.remove();
  }),
);

it.effect('/new discards a retained failure obligation without delivering it late', () =>
  Effect.gen(function* resetWhileFailurePending() {
    const fixture = yield* makeEngineFixture({ behavior: { startFailure: 'start unavailable' } });
    fixture.database.run(failStateTrigger('force_reset_failure', 'Failed'));
    fixture.push(inbound(1, 'request'));
    yield* fixture.engine.pollOnce;

    fixture.push(inbound(2, '/new'));
    yield* fixture.engine.pollOnce;
    yield* fixture.engine.pollOnce;

    expect(fixture.sent).toStrictEqual(['New chat started']);
    expect((yield* fixture.engine.snapshot).generationBroken).toBe(false);
    expect((yield* fixture.engine.snapshot).active).toBeNull();
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Superseded');
    fixture.engine.close();
    fixture.remove();
  }),
);

it.effect('migrates a v10 active attempt to exact batch identity without resubmitting it', () =>
  Effect.gen(function* legacyAttemptRecovery() {
    const gate = Promise.withResolvers<undefined>();
    const fixture = yield* makeMigratedEngineFixture(
      { gate: gate.promise },
      { id: 'thread-legacy', turns: [{ id: 'turn-legacy', items: [], status: 'inProgress' }] },
      seedVersionTenActiveAttempt,
    );

    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));

    expect(fixture.inputs).toStrictEqual([]);
    expect(fixture.turnsStarted).toStrictEqual([]);
    expect((yield* fixture.engine.snapshot).active?.codexTurnId).toBe('turn-legacy');
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM codex_attempts')
        .get()?.count,
    ).toBe(1);
    expect(
      fixture.database
        .query<{ input_batch_id: string; input_fingerprint: string }, []>(
          `SELECT input_batch_id, input_fingerprint
           FROM codex_attempts WHERE id = 'attempt-legacy'`,
        )
        .get(),
    ).toStrictEqual({
      input_batch_id: 'batch-legacy',
      input_fingerprint: canonicalInputFingerprint('legacy request'),
    });

    fixture.engine.close();
    gate.reject(new Error('stop closed monitor'));
    yield* fixture.engine.drain;
    fixture.remove();
  }),
);

it.effect('recovers every v10 steer before monitoring a completing turn', () =>
  Effect.gen(function* orderedSteerRecovery() {
    const steerGate = Promise.withResolvers<undefined>();
    const fixture = yield* makeMigratedEngineFixture(
      { steerGate: steerGate.promise },
      {
        id: 'thread-legacy',
        turns: [
          {
            id: 'turn-legacy',
            items: [{ clientId: 'attempt-steer-one', id: 'remote-steer-one', type: 'userMessage' }],
            status: 'inProgress',
          },
        ],
      },
      seedVersionTenSteerBacklog,
    );

    const recovery = yield* fixture.engine.pollOnce.pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.promise(() => Bun.sleep(0));

    expect(fixture.steers).toStrictEqual(['same steer']);
    expect(fixture.sent).toStrictEqual([]);
    expect((yield* fixture.engine.snapshot).active?.logicalTurnId).toBe('logical-legacy');

    steerGate.resolve();
    yield* Fiber.join(recovery);
    yield* fixture.engine.drain;

    expect(fixture.sent).toStrictEqual(['Done']);
    expect((yield* fixture.engine.snapshot).active).toBeNull();
    expect(
      fixture.database
        .query<{ input_batch_id: string | null; state: string }, []>(
          `SELECT ca.input_batch_id, ca.state
           FROM codex_attempts ca
           JOIN input_batches ib ON ib.id = ca.input_batch_id
           ORDER BY ib.sequence`,
        )
        .all(),
    ).toStrictEqual([
      { input_batch_id: 'batch-steer-one', state: 'Completed' },
      { input_batch_id: 'batch-steer-two', state: 'Completed' },
    ]);
    expect(fixture.turnsStarted).toStrictEqual([]);

    fixture.engine.close();
    fixture.remove();
  }),
);
