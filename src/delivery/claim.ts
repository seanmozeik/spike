import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import { DeliveryAttemptId, type OutboundChunkId } from '../domain/ids';
import { JournalTransactionError } from '../errors';
import type { TurnIdentity } from '../scheduler/model';
import type { DeliveryChunk, DeliveryJournal } from './model';

interface ClaimRow {
  readonly active_logical_turn_id: null | string;
  readonly generation_id: null | string;
  readonly generation_state: null | 'Current' | 'Superseded';
  readonly logical_turn_id: null | string;
  readonly logical_turn_state: null | string;
  readonly message_state: string;
  readonly scheduler_generation_id: null | string;
  readonly state: DeliveryChunk['state'];
}

const readClaim = (database: Database, chunkId: OutboundChunkId): ClaimRow | null =>
  database
    .query<ClaimRow, [string]>(
      `SELECT oc.state, om.state AS message_state, om.logical_turn_id,
              lt.generation_id, lt.state AS logical_turn_state,
              g.state AS generation_state, s.generation_id AS scheduler_generation_id,
              s.active_logical_turn_id
       FROM outbound_chunks oc
       JOIN outbound_messages om ON om.id = oc.outbound_message_id
       LEFT JOIN logical_turns lt ON lt.id = om.logical_turn_id
       LEFT JOIN generations g ON g.id = lt.generation_id
       LEFT JOIN scheduler_state s ON s.singleton = 1
       WHERE oc.id = ?`,
    )
    .get(chunkId);

const isPrepared = (row: ClaimRow | null): row is ClaimRow =>
  row?.state === 'Prepared' &&
  (row.message_state === 'Prepared' || row.message_state === 'Delivering');

const isOwnedBy = (row: ClaimRow, identity: TurnIdentity): boolean =>
  row.logical_turn_id === identity.logicalTurnId &&
  row.generation_id === identity.generationId &&
  row.logical_turn_state === 'Running' &&
  row.generation_state === 'Current' &&
  row.scheduler_generation_id === identity.generationId &&
  row.active_logical_turn_id === identity.logicalTurnId;

const hasActiveAttempt = (database: Database, chunkId: OutboundChunkId): boolean =>
  database
    .query<{ id: string }, [string]>(
      `SELECT id FROM delivery_attempts
       WHERE outbound_chunk_id = ? AND state IN ('Started','Sent','Unknown')
       LIMIT 1`,
    )
    .get(chunkId) !== null;

const insertAttempt = (
  database: Database,
  chunkId: OutboundChunkId,
  frontierRowId: number,
  startedAt: string,
): DeliveryAttemptId => {
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
       AND state IN ('Prepared','Delivering')`,
    [chunkId],
  );
  return attemptId;
};

const claimAttempt = (
  database: Database,
  chunkId: OutboundChunkId,
  frontierRowId: number,
  startedAt: string,
  identity: TurnIdentity | null,
): DeliveryAttemptId | null => {
  const row = readClaim(database, chunkId);
  if (!isPrepared(row) || (identity !== null && !isOwnedBy(row, identity))) {
    return null;
  }
  return hasActiveAttempt(database, chunkId)
    ? null
    : insertAttempt(database, chunkId, frontierRowId, startedAt);
};

const claimError = (transaction: string, cause: unknown): JournalTransactionError =>
  new JournalTransactionError({
    cause,
    message: `delivery journal transaction failed: ${transaction}`,
    transaction,
  });

const makeClaimAttempt = (database: Database): DeliveryJournal['claimAttempt'] => {
  const transaction = database.transaction(
    (chunkId: OutboundChunkId, frontierRowId: number, startedAt: string) =>
      claimAttempt(database, chunkId, frontierRowId, startedAt, null),
  );
  return (chunkId, frontierRowId, startedAt) =>
    Effect.try({
      catch: (cause) => claimError('claimAttempt', cause),
      try: () => transaction.immediate(chunkId, frontierRowId, startedAt.toISOString()),
    });
};

const makeClaimTurnAttempt = (database: Database): DeliveryJournal['claimTurnAttempt'] => {
  const transaction = database.transaction(
    (identity: TurnIdentity, chunkId: OutboundChunkId, frontierRowId: number, startedAt: string) =>
      claimAttempt(database, chunkId, frontierRowId, startedAt, identity),
  );
  return (identity, chunkId, frontierRowId, startedAt) =>
    Effect.try({
      catch: (cause) => claimError('claimTurnAttempt', cause),
      try: () => transaction.immediate(identity, chunkId, frontierRowId, startedAt.toISOString()),
    });
};

export { makeClaimAttempt, makeClaimTurnAttempt };
