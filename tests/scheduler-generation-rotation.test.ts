import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { openJournal } from '../src/database';
import { GenerationId, LogicalTurnId } from '../src/domain/ids';
import { makeSchedulerJournal } from '../src/journal/scheduler-journal';
import { SCHEDULE_CONFIGURATION_VERSION } from '../src/schedule/configuration';
import { transitionScheduler } from '../src/scheduler/transition';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('preserves a stale idle pool, then rotates it atomically before binding a thread', () =>
  Effect.gen(function* pooledConfigurationUpgrade() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-scheduler-upgrade-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    const now = new Date('2026-07-15T09:00:00Z');
    handle.database.run(
      `INSERT INTO generations(id, sequence, state, created_at, config_version)
       VALUES ('generation-old', 1, 'Current', ?, NULL)`,
      [now.toISOString()],
    );
    handle.database.run(
      `INSERT INTO inbound_messages(
         id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
       ) VALUES ('pooled', 'guid-pooled', 1, 'chat', 'handle', 'iMessage', 'preserve me', ?, ?)`,
      [now.toISOString(), now.toISOString()],
    );
    handle.database.run(
      `INSERT INTO scheduler_state(
         singleton, generation_id, active_logical_turn_id, active_codex_turn_id,
         active_acknowledged, generation_broken, timer_deadline_at, updated_at
       ) VALUES (1, 'generation-old', NULL, NULL, 0, 1, ?, ?)`,
      [new Date(now.getTime() + 3000).toISOString(), now.toISOString()],
    );
    handle.database.run(
      "INSERT INTO scheduler_pool_messages(inbound_message_id, ordinal) VALUES ('pooled', 0)",
    );
    const journal = makeSchedulerJournal(handle.database);
    const loaded = yield* journal.loadOrCreate(now);
    expect(loaded).toMatchObject({
      configurationCurrent: false,
      generationBroken: true,
      generationId: 'generation-old',
    });
    expect(loaded.pool.map(({ id }) => id)).toEqual(['pooled']);

    const transition = transitionScheduler(loaded, {
      deadlineAt: new Date(now.getTime() + 3000),
      kind: 'PoolTimer',
      newGenerationId: GenerationId.make('generation-new'),
      nextLogicalTurnId: LogicalTurnId.make('turn-new'),
    });
    yield* journal.commitTransition(transition, new Date(now.getTime() + 3000));

    const restarted = yield* makeSchedulerJournal(handle.database).loadOrCreate(
      new Date(now.getTime() + 3001),
    );
    expect(restarted).toMatchObject({
      active: { codexTurnId: null, logicalTurnId: 'turn-new' },
      codexThreadId: null,
      configurationCurrent: true,
      generationId: 'generation-new',
      pool: [],
    });
    expect(
      handle.database
        .query<{ config_version: string }, []>(
          "SELECT config_version FROM generations WHERE state = 'Current'",
        )
        .get(),
    ).toStrictEqual({ config_version: SCHEDULE_CONFIGURATION_VERSION });
    expect(
      handle.database
        .query<{ inbound_message_id: string }, []>(
          `SELECT ibm.inbound_message_id FROM input_batch_messages ibm
           JOIN input_batches ib ON ib.id = ibm.input_batch_id
           WHERE ib.logical_turn_id = 'turn-new'`,
        )
        .all(),
    ).toStrictEqual([{ inbound_message_id: 'pooled' }]);
    handle.close();
  }),
);

it.effect('refuses to rotate a stale generation with orphan nonterminal work', () =>
  Effect.gen(function* guardedConfigurationUpgrade() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-scheduler-guarded-upgrade-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    const now = new Date('2026-07-15T09:00:00Z');
    handle.database.run(
      `INSERT INTO generations(id, sequence, state, created_at, config_version)
       VALUES ('generation-old', 1, 'Current', ?, NULL)`,
      [now.toISOString()],
    );
    handle.database.run(
      `INSERT INTO logical_turns(
         id, generation_id, sequence, state, correlation_id, created_at
       ) VALUES ('orphan-turn', 'generation-old', 1, 'Running', 'correlation', ?)`,
      [now.toISOString()],
    );
    const journal = makeSchedulerJournal(handle.database);
    const loaded = yield* journal.loadOrCreate(now);
    expect(loaded.configurationCurrent).toBe(false);
    const newGenerationId = GenerationId.make('generation-new');
    const oldGenerationId = GenerationId.make('generation-old');
    const rotation = journal.commitTransition(
      {
        actions: [{ kind: 'RotateConfiguration', newGenerationId, oldGenerationId }],
        state: { ...loaded, configurationCurrent: true, generationId: newGenerationId },
      },
      now,
    );
    const rotationResult = yield* Effect.result(rotation);
    expect(rotationResult).toMatchObject({ _tag: 'Failure' });
    expect(
      handle.database
        .query<{ id: string }, []>("SELECT id FROM generations WHERE state = 'Current'")
        .get(),
    ).toStrictEqual({ id: 'generation-old' });
    handle.close();
  }),
);
