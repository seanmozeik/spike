import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { afterEach, expect } from 'vitest';

import { openJournal } from '../src/database';
import { CodexTurnId, GenerationId, InboundMessageId, LogicalTurnId } from '../src/domain/ids';
import { makeSchedulerJournal } from '../src/journal/scheduler-journal';
import type { PooledMessage } from '../src/scheduler/model';
import { poolDeadline } from '../src/scheduler/transition';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('reconstructs pooled timing and acknowledgement state after restart', () =>
  Effect.gen(function* schedulerJournalFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-scheduler-journal-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    const journal = makeSchedulerJournal(handle.database);
    const now = new Date('2026-07-14T18:00:00Z');
    const initial = yield* journal.loadOrCreate(now);
    const turnMessage: PooledMessage = {
      id: InboundMessageId.make('message-1'),
      receivedAt: now,
      text: 'first',
    };
    const pooledMessage: PooledMessage = {
      id: InboundMessageId.make('message-2'),
      receivedAt: new Date(now.getTime() + 1000),
      text: 'second',
    };
    for (const message of [turnMessage, pooledMessage]) {
      handle.database.run(
        `INSERT INTO inbound_messages(
           id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
         ) VALUES (?, ?, ?, 'chat', 'handle', 'iMessage', ?, ?, ?)`,
        [
          message.id,
          `guid-${message.id}`,
          message.id === turnMessage.id ? 1 : 2,
          message.text,
          message.receivedAt.toISOString(),
          message.receivedAt.toISOString(),
        ],
      );
    }
    const logicalTurnId = LogicalTurnId.make('turn-1');
    const started = {
      ...initial,
      active: { acknowledged: false, codexTurnId: null, logicalTurnId },
    } as const;
    yield* journal.commitTransition(
      { actions: [{ kind: 'StartTurn', logicalTurnId, messages: [turnMessage] }], state: started },
      now,
    );
    const running = {
      ...started,
      active: { acknowledged: false, codexTurnId: CodexTurnId.make('codex-turn'), logicalTurnId },
      pool: [pooledMessage],
    } as const;
    yield* journal.commitTransition({ actions: [], state: running }, now);
    yield* journal.commitTransition(
      {
        actions: [
          { at: new Date(now.getTime() + 2000), kind: 'RecordAcknowledgement', logicalTurnId },
        ],
        state: { ...running, active: { ...running.active, acknowledged: true } },
      },
      new Date(now.getTime() + 2000),
    );
    const restarted = yield* journal.loadOrCreate(new Date(now.getTime() + 2500));
    expect(restarted.active).toMatchObject({ acknowledged: true, logicalTurnId: 'turn-1' });
    expect(restarted.pool.map(({ id }) => id)).toEqual(['message-2']);
    expect(poolDeadline(restarted.pool)).toEqual(new Date(now.getTime() + 4000));

    yield* journal.commitTransition(
      { actions: [], state: { ...restarted, active: null, generationBroken: true } },
      new Date(now.getTime() + 2750),
    );
    const quarantined = yield* journal.loadOrCreate(new Date(now.getTime() + 2800));
    expect(quarantined.generationBroken).toBe(true);
    expect(quarantined.pool.map(({ id }) => id)).toEqual(['message-2']);

    const resetState = {
      active: null,
      codexThreadId: null,
      generationBroken: false,
      generationId: GenerationId.make('generation-2'),
      pool: [],
    } as const;
    const commandAt = new Date(now.getTime() + 3000);
    const commandId = InboundMessageId.make('command');
    handle.database.run(
      `INSERT INTO inbound_messages(
         id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
       ) VALUES (?, 'guid-command', 3, 'chat', 'handle', 'iMessage', '/new', ?, ?)`,
      [commandId, commandAt.toISOString(), commandAt.toISOString()],
    );
    yield* journal.commitTransition(
      {
        actions: [
          {
            commandMessageId: commandId,
            kind: 'ResetGeneration',
            newGenerationId: resetState.generationId,
            oldGenerationId: initial.generationId,
          },
        ],
        state: resetState,
      },
      commandAt,
    );
    const afterReset = yield* journal.loadOrCreate(new Date(now.getTime() + 4000));
    expect(afterReset).toEqual(resetState);
    expect(
      handle.database
        .query<{ state: string }, [string]>('SELECT state FROM generations WHERE id = ?')
        .get(initial.generationId)?.state,
    ).toBe('Superseded');
    expect(
      handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM handled_control_messages')
        .get()?.count,
    ).toBe(1);
    expect(
      handle.database
        .query<{ state: string }, [string]>('SELECT state FROM logical_turns WHERE id = ?')
        .get(logicalTurnId)?.state,
    ).toBe('Superseded');
    handle.close();
  }),
);

it.effect('recovers a generation thread bound before scheduler state persisted', () =>
  Effect.gen(function* generationThreadRecoveryFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-generation-thread-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    const journal = makeSchedulerJournal(handle.database);
    const initial = yield* journal.loadOrCreate(new Date('2026-07-15T09:00:00Z'));
    handle.database.run('UPDATE generations SET codex_thread_id = ? WHERE id = ?', [
      'thread-bound-before-crash',
      initial.generationId,
    ]);

    const restarted = yield* journal.loadOrCreate(new Date('2026-07-15T09:00:01Z'));

    expect(restarted.codexThreadId).toBe('thread-bound-before-crash');
    expect(
      handle.database
        .query<{ name: string }, []>('PRAGMA table_info(scheduler_state)')
        .all()
        .some((column) => column.name === 'codex_thread_id'),
    ).toBe(false);
    handle.close();
  }),
);

it.effect(
  'atomically rolls back completion and successor creation when state persistence fails',
  () =>
    Effect.gen(function* atomicSuccessorFixture() {
      const root = mkdtempSync(path.join(tmpdir(), 'spike-scheduler-atomic-'));
      roots.push(root);
      const handle = yield* openJournal(path.join(root, 'spike.db'));
      const journal = makeSchedulerJournal(handle.database);
      const now = new Date('2026-07-14T18:00:00Z');
      const initial = yield* journal.loadOrCreate(now);
      const firstId = LogicalTurnId.make('turn-1');
      const secondId = LogicalTurnId.make('turn-2');
      const firstMessage = {
        id: InboundMessageId.make('message-1'),
        receivedAt: now,
        text: 'first',
      } satisfies PooledMessage;
      const secondMessage = {
        id: InboundMessageId.make('message-2'),
        receivedAt: new Date(now.getTime() + 1000),
        text: 'second',
      } satisfies PooledMessage;
      for (const [rowId, message] of [firstMessage, secondMessage].entries()) {
        handle.database.run(
          `INSERT INTO inbound_messages(
           id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
         ) VALUES (?, ?, ?, 'chat', 'handle', 'iMessage', ?, ?, ?)`,
          [
            message.id,
            `guid-${message.id}`,
            rowId + 1,
            message.text,
            message.receivedAt.toISOString(),
            message.receivedAt.toISOString(),
          ],
        );
      }
      const running = {
        ...initial,
        active: {
          acknowledged: false,
          codexTurnId: CodexTurnId.make('codex-turn'),
          logicalTurnId: firstId,
        },
      } as const;
      yield* journal.commitTransition(
        {
          actions: [{ kind: 'StartTurn', logicalTurnId: firstId, messages: [firstMessage] }],
          state: running,
        },
        now,
      );
      const successor = {
        ...running,
        active: { acknowledged: false, codexTurnId: null, logicalTurnId: secondId },
      } as const;
      const transition = {
        actions: [
          { kind: 'CompleteTurn', logicalTurnId: firstId },
          { kind: 'StartTurn', logicalTurnId: secondId, messages: [secondMessage] },
        ],
        state: successor,
      } as const;
      handle.database.run(
        `CREATE TRIGGER fail_successor_state BEFORE UPDATE OF active_logical_turn_id ON scheduler_state
       WHEN NEW.active_logical_turn_id = 'turn-2'
       BEGIN SELECT RAISE(ABORT, 'forced successor state failure'); END`,
      );

      const failedAt = new Date(now.getTime() + 2000);
      const failed = yield* Effect.result(journal.commitTransition(transition, failedAt));
      expect(Result.isFailure(failed)).toBe(true);
      expect(
        handle.database
          .query<{ id: string; state: string }, []>(
            'SELECT id, state FROM logical_turns ORDER BY sequence',
          )
          .all(),
      ).toStrictEqual([{ id: 'turn-1', state: 'Running' }]);
      expect(
        handle.database
          .query<{ active_logical_turn_id: string }, []>(
            'SELECT active_logical_turn_id FROM scheduler_state WHERE singleton = 1',
          )
          .get()?.active_logical_turn_id,
      ).toBe('turn-1');

      handle.database.run('DROP TRIGGER fail_successor_state');
      yield* journal.commitTransition(transition, new Date(now.getTime() + 3000));
      expect(
        handle.database
          .query<{ id: string; state: string }, []>(
            'SELECT id, state FROM logical_turns ORDER BY sequence',
          )
          .all(),
      ).toStrictEqual([
        { id: 'turn-1', state: 'Completed' },
        { id: 'turn-2', state: 'Running' },
      ]);
      expect(
        handle.database
          .query<{ active_logical_turn_id: string }, []>(
            'SELECT active_logical_turn_id FROM scheduler_state WHERE singleton = 1',
          )
          .get()?.active_logical_turn_id,
      ).toBe('turn-2');
      handle.close();
    }),
);
