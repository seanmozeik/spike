import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import type { LogicalTurnId } from '../domain/ids';
import { JournalTransactionError } from '../errors';
import { inputBatchFingerprint } from '../scheduler/input-batch';
import type {
  PooledMessage,
  SchedulerAction,
  SchedulerState,
  SchedulerTransition,
} from '../scheduler/model';
import { makeLoadInputBatches, type PersistedInputBatch } from './scheduler-recovery';
import {
  currentGeneration,
  readSchedulerState,
  writeSchedulerState,
} from './scheduler-state-store';

interface SchedulerJournal {
  readonly commitTransition: (
    transition: SchedulerTransition,
    committedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly loadInputBatches: (
    logicalTurnId: LogicalTurnId,
    kind: 'Initial' | 'Steer',
  ) => Effect.Effect<readonly PersistedInputBatch[], JournalTransactionError>;
  readonly loadOrCreate: (now: Date) => Effect.Effect<SchedulerState, JournalTransactionError>;
}

const journalError = (transaction: string, cause: unknown): JournalTransactionError =>
  new JournalTransactionError({
    cause,
    message: `scheduler journal transaction failed: ${transaction}`,
    transaction,
  });

const insertInputBatch = (
  database: Database,
  logicalTurnId: LogicalTurnId,
  kind: 'Initial' | 'Steer',
  messages: readonly PooledMessage[],
  createdAt: string,
): void => {
  const batchId = randomUUID();
  database.run(
    `INSERT INTO input_batches(id, logical_turn_id, sequence, kind, fingerprint, created_at)
     VALUES (
       ?, ?,
       COALESCE((SELECT MAX(sequence) + 1 FROM input_batches WHERE logical_turn_id = ?), 1),
       ?, ?, ?
     )`,
    [batchId, logicalTurnId, logicalTurnId, kind, inputBatchFingerprint(messages), createdAt],
  );
  for (const [ordinal, message] of messages.entries()) {
    database.run(
      `INSERT INTO input_batch_messages(input_batch_id, inbound_message_id, ordinal)
       VALUES (?, ?, ?)`,
      [batchId, message.id, ordinal],
    );
  }
};

const resetGeneration = (
  database: Database,
  state: SchedulerState,
  action: Extract<SchedulerAction, { readonly kind: 'ResetGeneration' }>,
  resetAt: string,
): void => {
  const current = database
    .query<{ id: string }, []>("SELECT id FROM generations WHERE state = 'Current'")
    .get();
  if (
    current === null ||
    current.id !== action.oldGenerationId ||
    state.generationId !== action.newGenerationId
  ) {
    throw new Error('reset generation ownership does not match the scheduler transition');
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
    [action.commandMessageId, resetAt],
  );
};

const beginTurn = (
  database: Database,
  state: SchedulerState,
  action: Extract<SchedulerAction, { readonly kind: 'StartTurn' }>,
  createdAt: string,
): void => {
  database.run(
    `INSERT INTO logical_turns(
       id, generation_id, sequence, state, correlation_id, created_at
     ) VALUES (
       ?, ?, COALESCE((SELECT MAX(sequence) + 1 FROM logical_turns WHERE generation_id = ?), 1),
       'Running', ?, ?
     )`,
    [action.logicalTurnId, state.generationId, state.generationId, randomUUID(), createdAt],
  );
  insertInputBatch(database, action.logicalTurnId, 'Initial', action.messages, createdAt);
};

const failTurn = (
  database: Database,
  action: Extract<SchedulerAction, { readonly kind: 'FailTurn' }>,
  failedAt: string,
): void => {
  database.run(
    `UPDATE codex_attempts SET state = 'Failed', finished_at = ?
     WHERE logical_turn_id = ?
       AND state IN ('Prepared','Submitted','SubmissionUnknown','Accepted')`,
    [failedAt, action.logicalTurnId],
  );
  const result = database.run(
    `UPDATE logical_turns SET state = 'Failed', completed_at = ?
     WHERE id = ? AND state IN ('Submitted','Running')`,
    [failedAt, action.logicalTurnId],
  );
  if (result.changes !== 1) {
    throw new Error('failed transition expected one active logical turn');
  }
};

const completeTurn = (
  database: Database,
  action: Extract<SchedulerAction, { readonly kind: 'CompleteTurn' }>,
  completedAt: string,
): void => {
  database.run(
    "UPDATE logical_turns SET state = 'Completed', completed_at = ? WHERE id = ? AND state = 'Running'",
    [completedAt, action.logicalTurnId],
  );
};

const recordAcknowledgement = (
  database: Database,
  action: Extract<SchedulerAction, { readonly kind: 'RecordAcknowledgement' }>,
): void => {
  database.run(
    'UPDATE logical_turns SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?',
    [action.at.toISOString(), action.logicalTurnId],
  );
};

const consumeStatus = (
  database: Database,
  action: Extract<SchedulerAction, { readonly kind: 'ReplyStatus' }>,
  handledAt: string,
): void => {
  database.run(
    `INSERT OR IGNORE INTO handled_control_messages(inbound_message_id, command, handled_at)
     VALUES (?, '/status', ?)`,
    [action.commandMessageId, handledAt],
  );
};

const persistAction = (
  database: Database,
  state: SchedulerState,
  action: SchedulerAction,
  committedAt: string,
): void => {
  switch (action.kind) {
    case 'StartTurn': {
      beginTurn(database, state, action, committedAt);
      break;
    }
    case 'SteerTurn': {
      insertInputBatch(database, action.logicalTurnId, 'Steer', action.messages, committedAt);
      break;
    }
    case 'CompleteTurn': {
      completeTurn(database, action, committedAt);
      break;
    }
    case 'FailTurn': {
      failTurn(database, action, committedAt);
      break;
    }
    case 'RecordAcknowledgement': {
      recordAcknowledgement(database, action);
      break;
    }
    case 'ResetGeneration': {
      resetGeneration(database, state, action, committedAt);
      break;
    }
    case 'ReplyStatus': {
      consumeStatus(database, action, committedAt);
      break;
    }
    case 'BindThread':
    case 'IgnoreLateEvent':
    case 'ReplyNewChat':
    case 'SchedulePool': {
      break;
    }
    default: {
      const unreachable: never = action;
      throw new Error(`unsupported scheduler action: ${String(unreachable)}`);
    }
  }
};

const makeCommitTransition = (database: Database): SchedulerJournal['commitTransition'] => {
  const transaction = database.transaction(
    (transition: SchedulerTransition, committedAt: string): void => {
      for (const action of transition.actions) {
        persistAction(database, transition.state, action, committedAt);
      }
      const current = currentGeneration(database, committedAt);
      if (current !== transition.state.generationId) {
        throw new Error('scheduler state does not target the current generation');
      }
      writeSchedulerState(database, transition.state, committedAt);
    },
  );
  return (transition, committedAt) =>
    Effect.try({
      catch: (cause) => journalError('commitTransition', cause),
      try: () => {
        transaction(transition, committedAt.toISOString());
      },
    });
};

const makeLoadOrCreate = (database: Database): SchedulerJournal['loadOrCreate'] => {
  const transaction = database.transaction((now: string): SchedulerState => {
    const generationId = currentGeneration(database, now);
    const state = readSchedulerState(database, generationId);
    writeSchedulerState(database, state, now);
    return state;
  });
  return (now) =>
    Effect.try({
      catch: (cause) => journalError('loadOrCreate', cause),
      try: () => transaction(now.toISOString()),
    });
};

const makeSchedulerJournal = (database: Database): SchedulerJournal => ({
  commitTransition: makeCommitTransition(database),
  loadInputBatches: makeLoadInputBatches(database),
  loadOrCreate: makeLoadOrCreate(database),
});

export { makeSchedulerJournal };
export type { SchedulerJournal };
