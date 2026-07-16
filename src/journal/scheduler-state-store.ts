import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import {
  CodexThreadId,
  CodexTurnId,
  GenerationId,
  InboundMessageId,
  LogicalTurnId,
} from '../domain/ids';
import type { PooledMessage, SchedulerState } from '../scheduler/model';
import { poolDeadline } from '../scheduler/transition';

interface SchedulerRow {
  readonly active_acknowledged: number;
  readonly active_codex_turn_id: null | string;
  readonly active_logical_turn_id: null | string;
  readonly codex_thread_id: null | string;
  readonly generation_broken: number;
  readonly generation_id: string;
}

interface PoolRow {
  readonly id: string;
  readonly observed_at: string;
  readonly text: null | string;
}

const currentGeneration = (database: Database, now: string): GenerationId => {
  const current = database
    .query<{ id: string }, []>("SELECT id FROM generations WHERE state = 'Current'")
    .get();
  if (current !== null) {
    return GenerationId.make(current.id);
  }
  const generationId = GenerationId.make(randomUUID());
  database.run(
    `INSERT INTO generations(id, sequence, state, created_at)
     VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM generations), 1), 'Current', ?)`,
    [generationId, now],
  );
  return generationId;
};

const writeSchedulerState = (
  database: Database,
  state: SchedulerState,
  updatedAt: string,
): void => {
  database.run(
    `INSERT INTO scheduler_state(
       singleton, generation_id, active_logical_turn_id, active_codex_turn_id,
       active_acknowledged, generation_broken, timer_deadline_at, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       generation_id = excluded.generation_id,
       active_logical_turn_id = excluded.active_logical_turn_id,
       active_codex_turn_id = excluded.active_codex_turn_id,
       active_acknowledged = excluded.active_acknowledged,
       generation_broken = excluded.generation_broken,
       timer_deadline_at = excluded.timer_deadline_at,
       updated_at = excluded.updated_at`,
    [
      state.generationId,
      state.active?.logicalTurnId ?? null,
      state.active?.codexTurnId ?? null,
      state.active?.acknowledged === true ? 1 : 0,
      state.generationBroken ? 1 : 0,
      poolDeadline(state.pool)?.toISOString() ?? null,
      updatedAt,
    ],
  );
  database.run('DELETE FROM scheduler_pool_messages');
  for (const [ordinal, message] of state.pool.entries()) {
    database.run('INSERT INTO scheduler_pool_messages(inbound_message_id, ordinal) VALUES (?, ?)', [
      message.id,
      ordinal,
    ]);
  }
};

const readPool = (database: Database): readonly PooledMessage[] =>
  database
    .query<PoolRow, []>(
      `SELECT im.id, im.text, im.observed_at
       FROM scheduler_pool_messages spm
       JOIN inbound_messages im ON im.id = spm.inbound_message_id
       ORDER BY spm.ordinal`,
    )
    .all()
    .map((row) => ({
      id: InboundMessageId.make(row.id),
      receivedAt: new Date(row.observed_at),
      text: row.text ?? '',
    }));

const readSchedulerState = (database: Database, generationId: GenerationId): SchedulerState => {
  const row = database
    .query<SchedulerRow, []>(
      `SELECT s.generation_id, g.codex_thread_id, s.active_logical_turn_id,
              s.active_codex_turn_id, s.active_acknowledged, s.generation_broken
       FROM scheduler_state s
       JOIN generations g ON g.id = s.generation_id
       WHERE s.singleton = 1`,
    )
    .get();
  if (row === null || row.generation_id !== generationId) {
    return { active: null, codexThreadId: null, generationBroken: false, generationId, pool: [] };
  }
  return {
    active:
      row.active_logical_turn_id === null
        ? null
        : {
            acknowledged: row.active_acknowledged === 1,
            codexTurnId:
              row.active_codex_turn_id === null ? null : CodexTurnId.make(row.active_codex_turn_id),
            logicalTurnId: LogicalTurnId.make(row.active_logical_turn_id),
          },
    codexThreadId: row.codex_thread_id === null ? null : CodexThreadId.make(row.codex_thread_id),
    generationBroken: row.generation_broken === 1,
    generationId: GenerationId.make(row.generation_id),
    pool: readPool(database),
  };
};

export { currentGeneration, readSchedulerState, writeSchedulerState };
