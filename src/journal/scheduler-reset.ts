import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import { JournalTransactionError } from '../errors';
import type { PooledMessage, SchedulerState } from '../scheduler/model';
import { writeSchedulerState } from './scheduler-state-store';

type ResetGeneration = (
  state: SchedulerState,
  resetAt: Date,
  commandMessageId: PooledMessage['id'],
) => Effect.Effect<void, JournalTransactionError>;

const resetGeneration = (
  database: Database,
  state: SchedulerState,
  resetAt: string,
  commandMessageId: PooledMessage['id'],
): void => {
  const current = database
    .query<{ id: string }, []>("SELECT id FROM generations WHERE state = 'Current'")
    .get();
  if (current === null || current.id === state.generationId) {
    throw new Error('reset requires a new generation id distinct from the current generation');
  }
  database.run(
    "UPDATE generations SET state = 'Superseded', superseded_at = ? WHERE id = ? AND state = 'Current'",
    [resetAt, current.id],
  );
  database.run(
    `UPDATE codex_attempts SET state = 'Failed', finished_at = COALESCE(finished_at, ?)
     WHERE logical_turn_id IN (
       SELECT id FROM logical_turns WHERE generation_id = ?
     ) AND state IN ('Prepared','Submitted','SubmissionUnknown','Accepted')`,
    [resetAt, current.id],
  );
  database.run(
    `UPDATE logical_turns SET state = 'Superseded', completed_at = COALESCE(completed_at, ?)
     WHERE generation_id = ? AND state NOT IN ('Completed','Failed','Superseded')`,
    [resetAt, current.id],
  );
  database.run(
    `UPDATE outbound_messages SET state = 'Superseded'
     WHERE logical_turn_id IN (SELECT id FROM logical_turns WHERE generation_id = ?)
       AND state IN ('Prepared','Delivering')`,
    [current.id],
  );
  database.run(
    `INSERT INTO generations(id, sequence, state, created_at)
     VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM generations), 1), 'Current', ?)`,
    [state.generationId, resetAt],
  );
  database.run(
    `INSERT OR IGNORE INTO handled_control_messages(inbound_message_id, command, handled_at)
     VALUES (?, '/new', ?)`,
    [commandMessageId, resetAt],
  );
  writeSchedulerState(database, state, resetAt);
};

const makeResetGeneration = (database: Database): ResetGeneration => {
  const transaction = database.transaction(
    (state: SchedulerState, resetAt: string, commandMessageId: PooledMessage['id']) => {
      resetGeneration(database, state, resetAt, commandMessageId);
    },
  );
  return (state, resetAt, commandMessageId) =>
    Effect.try({
      catch: (cause) =>
        new JournalTransactionError({
          cause,
          message: 'scheduler journal transaction failed: resetGeneration',
          transaction: 'resetGeneration',
        }),
      try: () => {
        transaction(state, resetAt.toISOString(), commandMessageId);
      },
    });
};

export { makeResetGeneration };
