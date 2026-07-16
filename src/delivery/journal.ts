import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import { DeliveryAttemptId, OutboundChunkId, OutboundMessageId } from '../domain/ids';
import { JournalTransactionError } from '../errors';
import type { DeliveryChunk, DeliveryJournal } from './model';
import { makePrepare } from './prepare';

interface ChunkRow {
  readonly attempt_id: null | string;
  readonly attempt_number: null | number;
  readonly frontier_rowid: null | number;
  readonly id: string;
  readonly ordinal: number;
  readonly outbound_message_id: string;
  readonly state: DeliveryChunk['state'];
  readonly text: null | string;
}

const journalError = (transaction: string, cause: unknown): JournalTransactionError =>
  new JournalTransactionError({
    cause,
    message: `delivery journal transaction failed: ${transaction}`,
    transaction,
  });

const readChunks = (database: Database, outboundMessageId: string): readonly DeliveryChunk[] =>
  database
    .query<ChunkRow, [string]>(
      `SELECT oc.id, oc.outbound_message_id, oc.ordinal, oc.text, oc.state,
              da.id AS attempt_id, da.attempt_number, da.frontier_rowid
       FROM outbound_chunks oc
       LEFT JOIN delivery_attempts da ON da.id = (
         SELECT id FROM delivery_attempts
         WHERE outbound_chunk_id = oc.id ORDER BY attempt_number DESC LIMIT 1
       )
       WHERE oc.outbound_message_id = ? ORDER BY oc.ordinal`,
    )
    .all(outboundMessageId)
    .map((row) => ({
      attemptId: row.attempt_id === null ? null : DeliveryAttemptId.make(row.attempt_id),
      attemptNumber: row.attempt_number ?? 0,
      frontierRowId: row.frontier_rowid,
      id: OutboundChunkId.make(row.id),
      ordinal: row.ordinal,
      outboundMessageId: OutboundMessageId.make(row.outbound_message_id),
      state: row.state,
      text: row.text ?? '',
    }));

const makeBeginAttempt = (database: Database): DeliveryJournal['beginAttempt'] => {
  const transaction = database.transaction(
    (chunkId: OutboundChunkId, frontierRowId: number, startedAt: string): DeliveryAttemptId => {
      const attemptId = DeliveryAttemptId.make(randomUUID());
      database.run(
        `INSERT INTO delivery_attempts(
           id, outbound_chunk_id, attempt_number, state, started_at, frontier_rowid
         ) VALUES (
           ?, ?, COALESCE((SELECT MAX(attempt_number) + 1 FROM delivery_attempts WHERE outbound_chunk_id = ?), 1),
           'Started', ?, ?
         )`,
        [attemptId, chunkId, chunkId, startedAt, frontierRowId],
      );
      database.run(
        `UPDATE outbound_messages SET state = 'Delivering'
         WHERE id = (SELECT outbound_message_id FROM outbound_chunks WHERE id = ?)
           AND state = 'Prepared'`,
        [chunkId],
      );
      return attemptId;
    },
  );
  return (chunkId, frontierRowId, startedAt) =>
    Effect.try({
      catch: (cause) => journalError('beginAttempt', cause),
      try: () => transaction(chunkId, frontierRowId, startedAt.toISOString()),
    });
};

const makeListRecoverable = (database: Database): DeliveryJournal['listRecoverable'] =>
  Effect.try({
    catch: (cause) => journalError('listRecoverable', cause),
    try: () =>
      database
        .query<{ id: string }, []>(
          `SELECT id FROM outbound_messages WHERE state IN ('Prepared','Delivering') ORDER BY created_at`,
        )
        .all()
        .flatMap(({ id }) => readChunks(database, id))
        .filter(({ state }) => state !== 'Reconciled' && state !== 'Failed'),
  });

const makeMarkAttemptUnknown =
  (database: Database): DeliveryJournal['markAttemptUnknown'] =>
  (attemptId, error, finishedAt) =>
    Effect.try({
      catch: (cause) => journalError('markAttemptUnknown', cause),
      try: () => {
        database.run(
          `UPDATE delivery_attempts SET state = 'Unknown', finished_at = ?, error = ?
           WHERE id = ? AND state IN ('Started','Sent','Unknown')`,
          [finishedAt.toISOString(), error, attemptId],
        );
      },
    });

const makeMarkFailed =
  (database: Database): DeliveryJournal['markFailed'] =>
  (chunkId, error, finishedAt) =>
    Effect.try({
      catch: (cause) => journalError('markFailed', cause),
      try: () => {
        const transaction = database.transaction(() => {
          database.run(
            `UPDATE delivery_attempts SET state = 'Failed', finished_at = ?, error = ?
             WHERE id = (
               SELECT id FROM delivery_attempts
               WHERE outbound_chunk_id = ? ORDER BY attempt_number DESC LIMIT 1
             ) AND state IN ('Started','Sent','Unknown')`,
            [finishedAt.toISOString(), error, chunkId],
          );
          database.run("UPDATE outbound_chunks SET state = 'Failed' WHERE id = ?", [chunkId]);
          database.run(
            `UPDATE outbound_messages SET state = 'Failed'
             WHERE id = (SELECT outbound_message_id FROM outbound_chunks WHERE id = ?)`,
            [chunkId],
          );
        });
        transaction();
      },
    });

const makeMarkReconciled = (database: Database): DeliveryJournal['markReconciled'] => {
  const transaction = database.transaction(
    (
      attemptId: DeliveryAttemptId,
      chunkId: OutboundChunkId,
      messageRowId: number,
      messageGuid: string,
      finishedAt: string,
    ) => {
      database.run(
        `UPDATE delivery_attempts SET state = 'Reconciled', finished_at = ?
         WHERE id = ? AND state IN ('Started','Sent','Unknown','Reconciled')`,
        [finishedAt, attemptId],
      );
      database.run(
        `UPDATE outbound_chunks
         SET state = 'Reconciled', messages_rowid = ?, message_guid = ?
         WHERE id = ? AND state IN ('Prepared','Sent','Reconciled')`,
        [messageRowId, messageGuid, chunkId],
      );
      database.run(
        `UPDATE outbound_messages SET state = 'Delivered', delivered_at = ?
         WHERE id = (SELECT outbound_message_id FROM outbound_chunks WHERE id = ?)
           AND NOT EXISTS (
             SELECT 1 FROM outbound_chunks pending
             WHERE pending.outbound_message_id = outbound_messages.id
               AND pending.state != 'Reconciled'
           )`,
        [finishedAt, chunkId],
      );
    },
  );
  return (attemptId, chunkId, messageRowId, messageGuid, finishedAt) =>
    Effect.try({
      catch: (cause) => journalError('markReconciled', cause),
      try: () => {
        transaction(attemptId, chunkId, messageRowId, messageGuid, finishedAt.toISOString());
      },
    });
};

const makeMarkSent = (database: Database): DeliveryJournal['markSent'] => {
  const transaction = database.transaction(
    (attemptId: DeliveryAttemptId, chunkId: OutboundChunkId, finishedAt: string) => {
      database.run(
        "UPDATE delivery_attempts SET state = 'Sent', finished_at = ? WHERE id = ? AND state = 'Started'",
        [finishedAt, attemptId],
      );
      database.run(
        "UPDATE outbound_chunks SET state = 'Sent' WHERE id = ? AND state = 'Prepared'",
        [chunkId],
      );
      database.run(
        `UPDATE outbound_messages SET state = 'Delivered', delivered_at = ?
         WHERE id = (SELECT outbound_message_id FROM outbound_chunks WHERE id = ?)
           AND NOT EXISTS (
             SELECT 1 FROM outbound_chunks pending
             WHERE pending.outbound_message_id = outbound_messages.id
               AND pending.state NOT IN ('Sent','Reconciled')
           )`,
        [finishedAt, chunkId],
      );
    },
  );
  return (attemptId, chunkId, finishedAt) =>
    Effect.try({
      catch: (cause) => journalError('markSent', cause),
      try: () => {
        transaction(attemptId, chunkId, finishedAt.toISOString());
      },
    });
};

const makeDeliveryJournal = (database: Database): DeliveryJournal => {
  const prepare = makePrepare(database, (id, kind) => ({
    chunks: readChunks(database, id),
    id: OutboundMessageId.make(id),
    kind,
  }));
  return {
    beginAttempt: makeBeginAttempt(database),
    listRecoverable: makeListRecoverable(database),
    markAttemptUnknown: makeMarkAttemptUnknown(database),
    markFailed: makeMarkFailed(database),
    markReconciled: makeMarkReconciled(database),
    markSent: makeMarkSent(database),
    prepareAssistantMessage: prepare.assistant,
    prepareControlMessage: prepare.control,
  };
};

export { makeDeliveryJournal };
export type {
  AssistantMessageKind,
  DeliveryChunk,
  DeliveryJournal,
  PreparedDelivery,
} from './model';
