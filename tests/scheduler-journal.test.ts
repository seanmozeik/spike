import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
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
