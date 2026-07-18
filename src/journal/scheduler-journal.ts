import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import type { GenerationId, LogicalTurnId } from '../domain/ids';
import { JournalTransactionError } from '../errors';
import type { PooledMessage, SchedulerState } from '../scheduler/model';
import { makeLoadLatestBatchMessages } from './scheduler-recovery';
import { makeResetGeneration } from './scheduler-reset';
import {
  currentGeneration,
  readSchedulerState,
  writeSchedulerState,
} from './scheduler-state-store';

interface SchedulerJournal {
  readonly appendSteer: (
    logicalTurnId: LogicalTurnId,
    messages: readonly PooledMessage[],
    createdAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly beginTurn: (
    generationId: GenerationId,
    logicalTurnId: LogicalTurnId,
    messages: readonly PooledMessage[],
    createdAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly completeTurn: (
    logicalTurnId: LogicalTurnId,
    completedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly failTurn: (
    logicalTurnId: LogicalTurnId,
    completedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly loadLatestBatchMessages: (
    logicalTurnId: LogicalTurnId,
    kind: 'Initial' | 'Steer',
  ) => Effect.Effect<readonly PooledMessage[], JournalTransactionError>;
  readonly consumeControl: (
    messageId: PooledMessage['id'],
    command: '/new' | '/status',
    handledAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly loadOrCreate: (now: Date) => Effect.Effect<SchedulerState, JournalTransactionError>;
  readonly recordAcknowledgement: (
    logicalTurnId: LogicalTurnId,
    acknowledgedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly resetGeneration: (
    state: SchedulerState,
    resetAt: Date,
    commandMessageId: PooledMessage['id'],
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly save: (
    state: SchedulerState,
    updatedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
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
  const fingerprint = messages.map((message) => message.id).join(':');
  database.run(
    'INSERT INTO input_batches(id, logical_turn_id, kind, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)',
    [batchId, logicalTurnId, kind, fingerprint, createdAt],
  );
  for (const [ordinal, message] of messages.entries()) {
    database.run(
      `INSERT INTO input_batch_messages(input_batch_id, inbound_message_id, ordinal)
       VALUES (?, ?, ?)`,
      [batchId, message.id, ordinal],
    );
  }
};

const makeSave = (database: Database): SchedulerJournal['save'] => {
  const transaction = database.transaction((state: SchedulerState, updatedAt: string) => {
    const current = currentGeneration(database, updatedAt);
    if (current !== state.generationId) {
      throw new Error('scheduler state does not target the current generation');
    }
    writeSchedulerState(database, state, updatedAt);
  });
  return (state, updatedAt) =>
    Effect.try({
      catch: (cause) => journalError('save', cause),
      try: () => {
        transaction(state, updatedAt.toISOString());
      },
    });
};

const makeAppendSteer = (database: Database): SchedulerJournal['appendSteer'] => {
  const transaction = database.transaction(
    (logicalTurnId: LogicalTurnId, messages: readonly PooledMessage[], createdAt: string) => {
      insertInputBatch(database, logicalTurnId, 'Steer', messages, createdAt);
    },
  );
  return (logicalTurnId, messages, createdAt) =>
    Effect.try({
      catch: (cause) => journalError('appendSteer', cause),
      try: () => {
        transaction(logicalTurnId, messages, createdAt.toISOString());
      },
    });
};

const makeBeginTurn = (database: Database): SchedulerJournal['beginTurn'] => {
  const transaction = database.transaction(
    (
      generationId: GenerationId,
      logicalTurnId: LogicalTurnId,
      messages: readonly PooledMessage[],
      createdAt: string,
    ) => {
      database.run(
        `INSERT INTO logical_turns(
           id, generation_id, sequence, state, correlation_id, created_at
         ) VALUES (
           ?, ?, COALESCE((SELECT MAX(sequence) + 1 FROM logical_turns WHERE generation_id = ?), 1),
           'Running', ?, ?
         )`,
        [logicalTurnId, generationId, generationId, randomUUID(), createdAt],
      );
      insertInputBatch(database, logicalTurnId, 'Initial', messages, createdAt);
    },
  );
  return (generationId, logicalTurnId, messages, createdAt) =>
    Effect.try({
      catch: (cause) => journalError('beginTurn', cause),
      try: () => {
        transaction(generationId, logicalTurnId, messages, createdAt.toISOString());
      },
    });
};

const makeCompleteTurn =
  (database: Database): SchedulerJournal['completeTurn'] =>
  (logicalTurnId, completedAt) =>
    Effect.try({
      catch: (cause) => journalError('completeTurn', cause),
      try: () => {
        database.run(
          "UPDATE logical_turns SET state = 'Completed', completed_at = ? WHERE id = ? AND state = 'Running'",
          [completedAt.toISOString(), logicalTurnId],
        );
      },
    });

const makeFailTurn = (database: Database): SchedulerJournal['failTurn'] => {
  const transaction = database.transaction((logicalTurnId: string, completedAt: string) => {
    database.run(
      `UPDATE codex_attempts SET state = 'Failed', finished_at = ?
       WHERE logical_turn_id = ?
         AND state IN ('Prepared','Submitted','SubmissionUnknown','Accepted')`,
      [completedAt, logicalTurnId],
    );
    const result = database.run(
      `UPDATE logical_turns SET state = 'Failed', completed_at = ?
       WHERE id = ? AND state IN ('Submitted','Running')`,
      [completedAt, logicalTurnId],
    );
    if (result.changes !== 1) {
      throw new Error('failTurn expected one active logical turn');
    }
  });
  return (logicalTurnId, completedAt) =>
    Effect.try({
      catch: (cause) => journalError('failTurn', cause),
      try: () => {
        transaction(logicalTurnId, completedAt.toISOString());
      },
    });
};

const makeConsumeControl =
  (database: Database): SchedulerJournal['consumeControl'] =>
  (messageId, command, handledAt) =>
    Effect.try({
      catch: (cause) => journalError('consumeControl', cause),
      try: () => {
        database.run(
          `INSERT OR IGNORE INTO handled_control_messages(inbound_message_id, command, handled_at)
           VALUES (?, ?, ?)`,
          [messageId, command, handledAt.toISOString()],
        );
      },
    });

const makeLoadOrCreate =
  (database: Database): SchedulerJournal['loadOrCreate'] =>
  (now) =>
    Effect.try({
      catch: (cause) => journalError('loadOrCreate', cause),
      try: () => {
        const generationId = currentGeneration(database, now.toISOString());
        const state = readSchedulerState(database, generationId);
        writeSchedulerState(database, state, now.toISOString());
        return state;
      },
    });

const makeRecordAcknowledgement =
  (database: Database): SchedulerJournal['recordAcknowledgement'] =>
  (logicalTurnId, acknowledgedAt) =>
    Effect.try({
      catch: (cause) => journalError('recordAcknowledgement', cause),
      try: () => {
        database.run(
          'UPDATE logical_turns SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?',
          [acknowledgedAt.toISOString(), logicalTurnId],
        );
        database.run(
          `UPDATE scheduler_state SET active_acknowledged = 1, updated_at = ?
           WHERE singleton = 1 AND active_logical_turn_id = ?`,
          [acknowledgedAt.toISOString(), logicalTurnId],
        );
      },
    });

const makeSchedulerJournal = (database: Database): SchedulerJournal => ({
  appendSteer: makeAppendSteer(database),
  beginTurn: makeBeginTurn(database),
  completeTurn: makeCompleteTurn(database),
  consumeControl: makeConsumeControl(database),
  failTurn: makeFailTurn(database),
  loadLatestBatchMessages: makeLoadLatestBatchMessages(database),
  loadOrCreate: makeLoadOrCreate(database),
  recordAcknowledgement: makeRecordAcknowledgement(database),
  resetGeneration: makeResetGeneration(database),
  save: makeSave(database),
});

export { makeSchedulerJournal };
export type { SchedulerJournal };
