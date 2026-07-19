import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { afterEach, expect } from 'vitest';

import { openJournal, type JournalHandle } from '../src/database';
import { CodexTurnId, InboundMessageId, LogicalTurnId } from '../src/domain/ids';
import { makeSchedulerJournal, type SchedulerJournal } from '../src/journal/scheduler-journal';
import type { PooledMessage, SchedulerState, SchedulerTransition } from '../src/scheduler/model';

interface AtomicSchedulerFixture {
  readonly databasePath: string;
  readonly handle: JournalHandle;
  readonly initial: SchedulerState;
  readonly journal: SchedulerJournal;
}

const roots: string[] = [];
const NOW = new Date('2026-07-19T09:00:00.000Z');

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const makeFixture = Effect.fn('Test.makeAtomicSchedulerFixture')(
  function* makeAtomicSchedulerFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-scheduler-atomicity-'));
    roots.push(root);
    const databasePath = path.join(root, 'spike.db');
    const handle = yield* openJournal(databasePath);
    const journal = makeSchedulerJournal(handle.database);
    const initial = yield* journal.loadOrCreate(NOW);
    return { databasePath, handle, initial, journal } satisfies AtomicSchedulerFixture;
  },
);

const seedMessage = (
  database: Database,
  id: string,
  rowId: number,
  text: string,
  observedAt: Date,
): PooledMessage => {
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (?, ?, ?, 'chat', 'handle', 'iMessage', ?, ?, ?)`,
    [id, `guid-${id}`, rowId, text, observedAt.toISOString(), observedAt.toISOString()],
  );
  return { attachments: [], id: InboundMessageId.make(id), receivedAt: observedAt, text };
};

const count = (database: Database, table: string): number =>
  database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0;

const activeLogicalTurn = (database: Database): string | null | undefined =>
  database
    .query<{ active_logical_turn_id: string | null }, []>(
      'SELECT active_logical_turn_id FROM scheduler_state WHERE singleton = 1',
    )
    .get()?.active_logical_turn_id;

const startTransition = (
  initial: SchedulerState,
  logicalTurnId: LogicalTurnId,
  message: PooledMessage,
): SchedulerTransition => ({
  actions: [{ kind: 'StartTurn', logicalTurnId, messages: [message] }],
  state: { ...initial, active: { acknowledged: false, codexTurnId: null, logicalTurnId } },
});

it.effect('rolls back the entire StartTurn when its inbound claim faults', () =>
  Effect.gen(function* startTurnClaimFault() {
    const fixture = yield* makeFixture();
    const message = seedMessage(fixture.handle.database, 'start-message', 1, 'start', NOW);
    const logicalTurnId = LogicalTurnId.make('logical-start');
    const transition = startTransition(fixture.initial, logicalTurnId, message);
    fixture.handle.database.run(
      `CREATE TEMP TRIGGER fail_start_claim BEFORE INSERT ON input_batch_messages
       WHEN NEW.inbound_message_id = 'start-message'
       BEGIN SELECT RAISE(ABORT, 'forced StartTurn claim fault'); END`,
    );

    const failed = yield* Effect.result(fixture.journal.commitTransition(transition, NOW));

    expect(Result.isFailure(failed)).toBe(true);
    expect({
      active: activeLogicalTurn(fixture.handle.database),
      batches: count(fixture.handle.database, 'input_batches'),
      claims: count(fixture.handle.database, 'input_batch_messages'),
      turns: count(fixture.handle.database, 'logical_turns'),
    }).toStrictEqual({ active: null, batches: 0, claims: 0, turns: 0 });

    fixture.handle.database.run('DROP TRIGGER fail_start_claim');
    yield* fixture.journal.commitTransition(transition, new Date(NOW.getTime() + 1));
    expect({
      active: activeLogicalTurn(fixture.handle.database),
      batches: count(fixture.handle.database, 'input_batches'),
      claims: count(fixture.handle.database, 'input_batch_messages'),
      turns: count(fixture.handle.database, 'logical_turns'),
    }).toStrictEqual({ active: logicalTurnId, batches: 1, claims: 1, turns: 1 });
    fixture.handle.close();
  }),
);

it.effect('keeps a pooled message recoverable when its Steer claim faults', () =>
  Effect.gen(function* steerClaimFault() {
    const fixture = yield* makeFixture();
    const first = seedMessage(fixture.handle.database, 'initial-message', 1, 'start', NOW);
    const followUp = seedMessage(
      fixture.handle.database,
      'steer-message',
      2,
      'more detail',
      new Date(NOW.getTime() + 1),
    );
    const logicalTurnId = LogicalTurnId.make('logical-steer');
    const started = startTransition(fixture.initial, logicalTurnId, first).state;
    yield* fixture.journal.commitTransition(
      { actions: [{ kind: 'StartTurn', logicalTurnId, messages: [first] }], state: started },
      NOW,
    );
    const running = {
      ...started,
      active: { acknowledged: false, codexTurnId: CodexTurnId.make('codex-turn'), logicalTurnId },
    } as const;
    yield* fixture.journal.commitTransition({ actions: [], state: running }, NOW);
    const pooled = { ...running, pool: [followUp] } as const;
    yield* fixture.journal.commitTransition({ actions: [], state: pooled }, NOW);
    const transition = {
      actions: [
        {
          codexTurnId: running.active.codexTurnId,
          kind: 'SteerTurn',
          logicalTurnId,
          messages: [followUp],
        },
      ],
      state: { ...running, pool: [] },
    } as const;
    fixture.handle.database.run(
      `CREATE TEMP TRIGGER fail_steer_claim BEFORE INSERT ON input_batch_messages
       WHEN NEW.inbound_message_id = 'steer-message'
       BEGIN SELECT RAISE(ABORT, 'forced Steer claim fault'); END`,
    );

    const failed = yield* Effect.result(fixture.journal.commitTransition(transition, NOW));

    expect(Result.isFailure(failed)).toBe(true);
    expect((yield* fixture.journal.loadOrCreate(NOW)).pool.map(({ id }) => id)).toStrictEqual([
      followUp.id,
    ]);
    expect(
      fixture.handle.database
        .query<{ kind: string }, []>('SELECT kind FROM input_batches ORDER BY sequence')
        .all(),
    ).toStrictEqual([{ kind: 'Initial' }]);

    fixture.handle.database.run('DROP TRIGGER fail_steer_claim');
    yield* fixture.journal.commitTransition(transition, new Date(NOW.getTime() + 1));
    expect((yield* fixture.journal.loadOrCreate(NOW)).pool).toStrictEqual([]);
    expect(
      fixture.handle.database
        .query<{ kind: string }, []>('SELECT kind FROM input_batches ORDER BY sequence')
        .all(),
    ).toStrictEqual([{ kind: 'Initial' }, { kind: 'Steer' }]);
    expect(count(fixture.handle.database, 'input_batch_messages')).toBe(2);
    fixture.handle.close();
  }),
);

it.effect('does not partially persist a scheduler state whose SQLite save faults', () =>
  Effect.gen(function* schedulerStateFault() {
    const fixture = yield* makeFixture();
    const broken = { ...fixture.initial, generationBroken: true };
    fixture.handle.database.run(
      `CREATE TEMP TRIGGER fail_scheduler_state BEFORE UPDATE OF generation_broken ON scheduler_state
       WHEN NEW.generation_broken = 1
       BEGIN SELECT RAISE(ABORT, 'forced scheduler-state save fault'); END`,
    );

    const failed = yield* Effect.result(
      fixture.journal.commitTransition({ actions: [], state: broken }, NOW),
    );

    expect(Result.isFailure(failed)).toBe(true);
    expect((yield* fixture.journal.loadOrCreate(NOW)).generationBroken).toBe(false);
    fixture.handle.database.run('DROP TRIGGER fail_scheduler_state');
    yield* fixture.journal.commitTransition({ actions: [], state: broken }, NOW);
    expect((yield* fixture.journal.loadOrCreate(NOW)).generationBroken).toBe(true);
    fixture.handle.close();
  }),
);

it.effect('rolls back completion when successor creation cannot reach scheduler state', () =>
  Effect.gen(function* successorFault() {
    const fixture = yield* makeFixture();
    const first = seedMessage(fixture.handle.database, 'first-message', 1, 'first', NOW);
    const second = seedMessage(
      fixture.handle.database,
      'second-message',
      2,
      'second',
      new Date(NOW.getTime() + 1),
    );
    const firstId = LogicalTurnId.make('turn-first');
    const secondId = LogicalTurnId.make('turn-second');
    const started = startTransition(fixture.initial, firstId, first).state;
    yield* fixture.journal.commitTransition(
      {
        actions: [{ kind: 'StartTurn', logicalTurnId: firstId, messages: [first] }],
        state: started,
      },
      NOW,
    );
    const running = {
      ...started,
      active: {
        acknowledged: false,
        codexTurnId: CodexTurnId.make('codex-first'),
        logicalTurnId: firstId,
      },
    } as const;
    yield* fixture.journal.commitTransition({ actions: [], state: running }, NOW);
    const successor = {
      actions: [
        { kind: 'CompleteTurn', logicalTurnId: firstId },
        { kind: 'StartTurn', logicalTurnId: secondId, messages: [second] },
      ],
      state: {
        ...running,
        active: { acknowledged: false, codexTurnId: null, logicalTurnId: secondId },
      },
    } as const;
    fixture.handle.database.run(
      `CREATE TEMP TRIGGER fail_successor_state
       BEFORE UPDATE OF active_logical_turn_id ON scheduler_state
       WHEN NEW.active_logical_turn_id = 'turn-second'
       BEGIN SELECT RAISE(ABORT, 'forced successor scheduler-state fault'); END`,
    );

    const failed = yield* Effect.result(fixture.journal.commitTransition(successor, NOW));

    expect(Result.isFailure(failed)).toBe(true);
    expect(
      fixture.handle.database
        .query<{ id: string; state: string }, []>(
          'SELECT id, state FROM logical_turns ORDER BY sequence',
        )
        .all(),
    ).toStrictEqual([{ id: firstId, state: 'Running' }]);
    expect(activeLogicalTurn(fixture.handle.database)).toBe(firstId);
    expect(count(fixture.handle.database, 'input_batches')).toBe(1);

    fixture.handle.database.run('DROP TRIGGER fail_successor_state');
    yield* fixture.journal.commitTransition(successor, new Date(NOW.getTime() + 1));
    expect(
      fixture.handle.database
        .query<{ id: string; state: string }, []>(
          'SELECT id, state FROM logical_turns ORDER BY sequence',
        )
        .all(),
    ).toStrictEqual([
      { id: firstId, state: 'Completed' },
      { id: secondId, state: 'Running' },
    ]);
    expect(activeLogicalTurn(fixture.handle.database)).toBe(secondId);
    expect(count(fixture.handle.database, 'input_batches')).toBe(2);
    fixture.handle.close();
  }),
);

it.effect('reopens one claimed StartTurn after a crash before any side effect', () =>
  Effect.gen(function* restartAfterStartCommit() {
    const fixture = yield* makeFixture();
    const message = seedMessage(fixture.handle.database, 'restart-message', 1, 'survive', NOW);
    const logicalTurnId = LogicalTurnId.make('logical-restart');
    yield* fixture.journal.commitTransition(
      startTransition(fixture.initial, logicalTurnId, message),
      NOW,
    );
    fixture.handle.close();

    const restartedHandle = yield* openJournal(fixture.databasePath);
    const restartedJournal = makeSchedulerJournal(restartedHandle.database);
    const restarted = yield* restartedJournal.loadOrCreate(new Date(NOW.getTime() + 1));
    const initialBatches = yield* restartedJournal.loadInputBatches(logicalTurnId, 'Initial');

    expect(restarted.active).toStrictEqual({
      acknowledged: false,
      codexTurnId: null,
      logicalTurnId,
    });
    expect(initialBatches).toHaveLength(1);
    expect(initialBatches[0]?.messages.map(({ id }) => id)).toStrictEqual([message.id]);
    expect({
      batches: count(restartedHandle.database, 'input_batches'),
      claims: count(restartedHandle.database, 'input_batch_messages'),
      turns: count(restartedHandle.database, 'logical_turns'),
    }).toStrictEqual({ batches: 1, claims: 1, turns: 1 });
    restartedHandle.close();
  }),
);
