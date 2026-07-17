import type { Database } from 'bun:sqlite';

import type { Effect } from 'effect';

import type { JsonRpcId } from '../codex/server-request-registry';
import type { JournalTransactionError } from '../errors';
import { parseRow, type ApprovalRow } from './journal-row';
import { wrap } from './journal-shared';
import type { ApprovalCommand, ApprovalRecord, CommandResolution } from './journal-types';
import { decisionResponse, type ApprovalState } from './model';

type RecordListEffect = Effect.Effect<readonly ApprovalRecord[], JournalTransactionError>;

const transitionRows = (
  database: Database,
  rows: readonly ApprovalRow[],
  state: Exclude<ApprovalState, 'Approved' | 'Denied' | 'Pending'>,
  at: Date,
  withResponse: boolean,
): readonly ApprovalRecord[] => {
  const records: ApprovalRecord[] = [];
  for (const row of rows) {
    const record = parseRow(row);
    const response = withResponse
      ? decisionResponse(record, state === 'Expired' ? 'expired' : 'cancelled')
      : null;
    database.run(
      `UPDATE approval_requests SET state = ?, resolved_at = ?, response_json = ?
       WHERE id = ? AND state = 'Pending'`,
      [state, at.toISOString(), response === null ? null : JSON.stringify(response), row.id],
    );
    records.push({ ...record, response, state });
  }
  return records;
};

const pendingRows = (
  database: Database,
  predicate: string,
  parameter: string,
): readonly ApprovalRow[] =>
  database
    .query<ApprovalRow, [string]>(
      `SELECT * FROM approval_requests WHERE state = 'Pending' AND ${predicate} ORDER BY requested_at`,
    )
    .all(parameter);

const cancelConnection = (database: Database, connectionId: string, at: Date): RecordListEffect =>
  wrap('cancelConnectionApprovals', () =>
    transitionRows(
      database,
      pendingRows(database, 'connection_id = ?', connectionId),
      'Cancelled',
      at,
      true,
    ),
  );

const expireDue = (database: Database, now: Date): RecordListEffect =>
  wrap('expireApprovals', () =>
    transitionRows(
      database,
      pendingRows(database, 'expires_at <= ?', now.toISOString()),
      'Expired',
      now,
      true,
    ),
  );

const markConnection = (
  database: Database,
  connectionId: string,
  at: Date,
  predicate: 'connection_id != ?' | 'connection_id = ?',
  transaction: string,
): RecordListEffect =>
  wrap(transaction, () =>
    transitionRows(database, pendingRows(database, predicate, connectionId), 'Orphaned', at, false),
  );

const markOrphaned = (database: Database, connectionId: string, at: Date): RecordListEffect =>
  wrap('orphanApprovals', () => {
    const rows = database
      .query<ApprovalRow, [string]>(
        `SELECT * FROM approval_requests WHERE connection_id != ? AND (
           state = 'Pending' OR (
             responded_at IS NULL AND response_json IS NOT NULL
             AND state IN ('Approved','Denied','Expired','Cancelled')
           )
         ) ORDER BY requested_at`,
      )
      .all(connectionId);
    database.run(
      `UPDATE approval_requests SET state = 'Orphaned', resolved_at = ?
       WHERE connection_id != ? AND state != 'Orphaned' AND (
         state = 'Pending' OR (responded_at IS NULL AND response_json IS NOT NULL)
       )`,
      [at.toISOString(), connectionId],
    );
    const records: ApprovalRecord[] = [];
    for (const row of rows) {
      records.push({ ...parseRow(row), state: 'Orphaned' });
    }
    return records;
  });

const orphanConnection = (database: Database, connectionId: string, at: Date): RecordListEffect =>
  markConnection(database, connectionId, at, 'connection_id = ?', 'orphanConnectionApprovals');

const recordUnhandled = (
  database: Database,
  command: ApprovalCommand,
  outcome: 'Invalid' | 'NoPending',
  at: Date,
): CommandResolution => {
  const normalized = command.text.trim().toLowerCase();
  database.run(
    `INSERT INTO handled_approval_messages(
       inbound_message_id, approval_id, command, outcome, handled_at
     ) VALUES (?, NULL, ?, ?, ?)`,
    [command.id, outcome === 'Invalid' ? 'invalid' : normalized, outcome, at.toISOString()],
  );
  return { kind: outcome, sourceId: command.id };
};

const resolveDisplayed = (
  database: Database,
  command: ApprovalCommand,
  normalized: '/no' | '/yes',
  at: Date,
): CommandResolution => {
  const row = database
    .query<ApprovalRow, [string]>(
      `SELECT * FROM approval_requests WHERE state = 'Pending'
       AND delivered_at IS NOT NULL AND expires_at > ? ORDER BY requested_at LIMIT 1`,
    )
    .get(at.toISOString());
  if (row === null) {
    return recordUnhandled(database, command, 'NoPending', at);
  }
  const decision = normalized === '/yes' ? 'yes' : 'no';
  const state = decision === 'yes' ? 'Approved' : 'Denied';
  const record = parseRow(row);
  const response = decisionResponse(record, decision);
  const changed = database.run(
    `UPDATE approval_requests SET state = ?, resolved_at = ?,
       resolving_inbound_message_id = ?, response_json = ? WHERE id = ? AND state = 'Pending'`,
    [state, at.toISOString(), command.id, JSON.stringify(response), row.id],
  );
  if (changed.changes !== 1) {
    return { kind: 'NoPending', sourceId: command.id };
  }
  database.run(
    `INSERT INTO handled_approval_messages(
       inbound_message_id, approval_id, command, outcome, handled_at
     ) VALUES (?, ?, ?, 'Resolved', ?)`,
    [command.id, row.id, normalized, at.toISOString()],
  );
  return {
    decision,
    kind: 'Resolved',
    record: { ...record, response, state },
    sourceId: command.id,
  };
};

const resolveCommand = (
  database: Database,
  command: ApprovalCommand,
  at: Date,
): Effect.Effect<CommandResolution, JournalTransactionError> =>
  wrap('resolveApprovalCommand', (): CommandResolution => {
    const normalized = command.text.trim().toLowerCase();
    if (!normalized.startsWith('/yes') && !normalized.startsWith('/no')) {
      return { kind: 'Ignored' };
    }
    const handled = database
      .query<{ inbound_message_id: string }, [string]>(
        'SELECT inbound_message_id FROM handled_approval_messages WHERE inbound_message_id = ?',
      )
      .get(command.id);
    if (handled !== null) {
      return { kind: 'Ignored' };
    }
    const transaction = database.transaction((): CommandResolution => {
      if (normalized !== '/yes' && normalized !== '/no') {
        return recordUnhandled(database, command, 'Invalid', at);
      }
      return resolveDisplayed(database, command, normalized, at);
    });
    return transaction();
  });

const resolveUpstream = (
  database: Database,
  connectionId: string,
  rpcRequestId: JsonRpcId,
  at: Date,
): Effect.Effect<ApprovalRecord | null, JournalTransactionError> =>
  wrap('resolveApprovalUpstream', () => {
    const row = database
      .query<ApprovalRow, [string, string]>(
        `SELECT * FROM approval_requests WHERE connection_id = ?
         AND rpc_request_id_json = ? AND state = 'Pending'`,
      )
      .get(connectionId, JSON.stringify(rpcRequestId));
    if (row === null) {
      return null;
    }
    database.run(
      "UPDATE approval_requests SET state = 'Cancelled', resolved_at = ? WHERE id = ? AND state = 'Pending'",
      [at.toISOString(), row.id],
    );
    return { ...parseRow(row), state: 'Cancelled' as const };
  });

export {
  cancelConnection,
  expireDue,
  markOrphaned,
  orphanConnection,
  resolveCommand,
  resolveUpstream,
};
