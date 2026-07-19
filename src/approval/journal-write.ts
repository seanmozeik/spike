import type { Database } from 'bun:sqlite';

import type { Effect } from 'effect';

import type { ApprovalId } from '../domain/ids';
import { tryJournalTransaction, type JournalTransactionError } from '../errors';
import { parseRow, selectById, type ApprovalRow } from './journal-row';
import type { ApprovalRecord } from './journal-types';
import { decisionResponse, type ApprovalRequest } from './model';

type RecordEffect = Effect.Effect<ApprovalRecord, JournalTransactionError>;
type OptionalRecordEffect = Effect.Effect<ApprovalRecord | null, JournalTransactionError>;
type VoidEffect = Effect.Effect<void, JournalTransactionError>;

const enqueue = (
  database: Database,
  request: ApprovalRequest,
  connectionId: string,
): RecordEffect =>
  tryJournalTransaction(
    'enqueueApproval',
    'approval journal transaction failed: enqueueApproval',
    () => {
      database.run(
        `INSERT OR IGNORE INTO approval_requests(
         id, connection_id, rpc_request_id_json, method, thread_id, turn_id, logical_turn_id,
         item_id, operation, params_json, available_decisions_json, command_text, cwd,
         file_paths_json, reason, state, requested_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?,
         (SELECT logical_turn_id FROM codex_attempts WHERE codex_turn_id = ? LIMIT 1),
         ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`,
        [
          request.id,
          connectionId,
          JSON.stringify(request.rpcRequestId),
          request.method,
          request.threadId,
          request.turnId,
          request.turnId,
          request.itemId,
          request.operation,
          JSON.stringify(request.params),
          request.availableDecisions === null ? null : JSON.stringify(request.availableDecisions),
          request.command,
          request.cwd,
          JSON.stringify(request.filePaths),
          request.reason,
          request.requestedAt.toISOString(),
          request.expiresAt.toISOString(),
        ],
      );
      const row = database
        .query<ApprovalRow, [string, string]>(
          'SELECT * FROM approval_requests WHERE connection_id = ? AND rpc_request_id_json = ?',
        )
        .get(connectionId, JSON.stringify(request.rpcRequestId));
      if (row === null) {
        throw new Error('approval insert did not produce a record');
      }
      return parseRow(row);
    },
  );

const markDelivered = (database: Database, id: ApprovalId, at: Date): VoidEffect =>
  tryJournalTransaction(
    'markApprovalDelivered',
    'approval journal transaction failed: markApprovalDelivered',
    () => {
      database.run(
        `UPDATE approval_requests SET delivered_at = COALESCE(delivered_at, ?),
         delivery_attempted_at = COALESCE(delivery_attempted_at, ?)
       WHERE id = ? AND state = 'Pending'`,
        [at.toISOString(), at.toISOString(), id],
      );
    },
  );

const markDeliveryFailed = (
  database: Database,
  id: ApprovalId,
  error: string,
  at: Date,
): OptionalRecordEffect =>
  tryJournalTransaction(
    'failApprovalDelivery',
    'approval journal transaction failed: failApprovalDelivery',
    () => {
      const record = selectById(database, id);
      if (record?.state !== 'Pending') {
        return null;
      }
      const response = decisionResponse(record, 'expired');
      database.run(
        `UPDATE approval_requests SET state = 'Expired', delivery_attempted_at = ?,
         delivery_error = ?, resolved_at = ?, response_json = ? WHERE id = ? AND state = 'Pending'`,
        [at.toISOString(), error, at.toISOString(), JSON.stringify(response), id],
      );
      return { ...record, response, state: 'Expired' as const };
    },
  );

const markResponded = (database: Database, id: ApprovalId, at: Date): VoidEffect =>
  tryJournalTransaction(
    'markApprovalResponded',
    'approval journal transaction failed: markApprovalResponded',
    () => {
      database.run('UPDATE approval_requests SET responded_at = ? WHERE id = ?', [
        at.toISOString(),
        id,
      ]);
    },
  );

const markResponseFailed = (
  database: Database,
  id: ApprovalId,
  error: string,
  at: Date,
): VoidEffect =>
  tryJournalTransaction(
    'failApprovalResponse',
    'approval journal transaction failed: failApprovalResponse',
    () => {
      database.run(
        `UPDATE approval_requests SET state = 'Orphaned', delivery_error = ?, resolved_at = ?
       WHERE id = ? AND responded_at IS NULL`,
        [error, at.toISOString(), id],
      );
    },
  );

export { enqueue, markDelivered, markDeliveryFailed, markResponded, markResponseFailed };
