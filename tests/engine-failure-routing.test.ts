import { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect, Fiber, Result } from 'effect';
import { expect } from 'vitest';

import { canonicalInputFingerprint } from '../src/codex/reconcile';
import {
  AccountId,
  CodexThreadId,
  CodexTurnId,
  GenerationId,
  InboundMessageId,
  LogicalTurnId,
} from '../src/domain/ids';
import { makeCodexJournal } from '../src/journal/codex-journal';
import { makeSchedulerJournal } from '../src/journal/scheduler-journal';
import type { PooledMessage } from '../src/scheduler/model';
import { transitionScheduler } from '../src/scheduler/transition';
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

const RESTART_AT = new Date('2026-07-19T23:30:00.000Z');

const seedRestartMessage = (
  database: Database,
  id: string,
  rowId: number,
  text: string,
): PooledMessage => {
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (?, ?, ?, 'chat', 'handle', 'iMessage', ?, ?, ?)`,
    [id, `guid-${id}`, rowId, text, RESTART_AT.toISOString(), RESTART_AT.toISOString()],
  );
  return { attachments: [], id: InboundMessageId.make(id), receivedAt: RESTART_AT, text };
};

const seedFailedCompletionCommit = (databasePath: string): void => {
  const database = new Database(databasePath, { strict: true });
  try {
    const scheduler = makeSchedulerJournal(database);
    const codex = makeCodexJournal(database);
    const initial = Effect.runSync(scheduler.loadOrCreate(RESTART_AT));
    const logicalTurnId = LogicalTurnId.make('logical-completion-restart');
    const threadId = CodexThreadId.make('thread-completion-restart');
    const turnId = CodexTurnId.make('turn-completion-restart');
    const initialMessage = seedRestartMessage(database, 'restart-initial', 1, 'initial request');
    const steerMessage = seedRestartMessage(database, 'restart-steer', 2, 'follow-up detail');
    const started = {
      ...initial,
      active: { acknowledged: false, codexTurnId: null, logicalTurnId },
    } as const;
    Effect.runSync(
      scheduler.commitTransition(
        {
          actions: [{ kind: 'StartTurn', logicalTurnId, messages: [initialMessage] }],
          state: started,
        },
        RESTART_AT,
      ),
    );
    const running = {
      ...started,
      active: { acknowledged: false, codexTurnId: turnId, logicalTurnId },
      codexThreadId: threadId,
    } as const;
    Effect.runSync(scheduler.commitTransition({ actions: [], state: running }, RESTART_AT));
    Effect.runSync(
      scheduler.commitTransition(
        {
          actions: [
            { codexTurnId: turnId, kind: 'SteerTurn', logicalTurnId, messages: [steerMessage] },
          ],
          state: running,
        },
        RESTART_AT,
      ),
    );
    for (const [kind, message] of [
      ['Initial', initialMessage],
      ['Steer', steerMessage],
    ] as const) {
      const [batch] = Effect.runSync(scheduler.loadInputBatches(logicalTurnId, kind));
      if (batch === undefined) {
        throw new Error(`expected persisted ${kind} input batch`);
      }
      const attemptId = Effect.runSync(
        codex.beginCodexAttempt({
          accountId: AccountId.make('test-account'),
          batchId: batch.id,
          fingerprint: canonicalInputFingerprint(message.text),
          frontier: { itemIds: [], turnIds: [turnId] },
          logicalTurnId,
          startedAt: RESTART_AT,
          submissionKind: kind === 'Initial' ? 'Start' : 'Steer',
          threadId,
        }),
      );
      Effect.runSync(codex.acceptCodexTurn(attemptId, threadId, turnId));
    }
    database.run(
      `CREATE TEMP TRIGGER force_completion_scheduler_save_failure
       BEFORE UPDATE OF active_logical_turn_id ON scheduler_state
       WHEN OLD.active_logical_turn_id IS NOT NULL AND NEW.active_logical_turn_id IS NULL
       BEGIN SELECT RAISE(ABORT, 'forced completion scheduler save failure'); END`,
    );
    const completedAt = new Date(RESTART_AT.getTime() + 1000);
    const completion = transitionScheduler(running, {
      at: completedAt,
      kind: 'TurnCompleted',
      logicalTurnId,
      newGenerationId: GenerationId.make('unused-generation'),
      nextLogicalTurnId: LogicalTurnId.make('unused-logical-turn'),
    });
    const completionCommit = scheduler.commitTransition(completion, completedAt);
    const failed = Effect.runSync(Effect.result(completionCommit));
    expect(Result.isFailure(failed)).toBe(true);
    expect(
      database
        .query<{ state: string; submission_kind: string }, []>(
          'SELECT submission_kind, state FROM codex_attempts ORDER BY submission_kind',
        )
        .all(),
    ).toStrictEqual([
      { state: 'Accepted', submission_kind: 'Start' },
      { state: 'Accepted', submission_kind: 'Steer' },
    ]);
    expect(
      database
        .query<{ state: string }, []>(
          "SELECT state FROM logical_turns WHERE id = 'logical-completion-restart'",
        )
        .get(),
    ).toStrictEqual({ state: 'Running' });
  } finally {
    database.close();
  }
};

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

it.effect('does not resubmit a steer after a failed completion commit and restart', () =>
  Effect.gen(function* completionRestartRecovery() {
    const gate = Promise.withResolvers<undefined>();
    const fixture = yield* makeEngineFixture({
      beforeOpen: seedFailedCompletionCommit,
      behavior: { gate: gate.promise },
      now: (): Date => new Date(RESTART_AT.getTime() + 2000),
      snapshot: {
        id: 'thread-completion-restart',
        turns: [{ id: 'turn-completion-restart', items: [], status: 'inProgress' }],
      },
    });

    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));

    expect(fixture.inputs).toStrictEqual([]);
    expect(fixture.steers).toStrictEqual([]);
    expect(fixture.turnsStarted).toStrictEqual([]);
    expect((yield* fixture.engine.snapshot).active?.logicalTurnId).toBe(
      'logical-completion-restart',
    );
    expect(
      fixture.database
        .query<{ state: string; submission_kind: string }, []>(
          'SELECT submission_kind, state FROM codex_attempts ORDER BY submission_kind',
        )
        .all(),
    ).toStrictEqual([
      { state: 'Accepted', submission_kind: 'Start' },
      { state: 'Accepted', submission_kind: 'Steer' },
    ]);

    fixture.engine.close();
    gate.reject(new Error('stop recovered monitor'));
    yield* fixture.engine.drain;
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
