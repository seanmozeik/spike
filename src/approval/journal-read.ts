import type { Database } from 'bun:sqlite';

import type { Effect } from 'effect';

import type { JsonRpcId } from '../codex/server-request-registry';
import { InboundMessageId, type MessagesRowId } from '../domain/ids';
import type { JournalTransactionError } from '../errors';
import { parseApprovalCommand } from './command';
import { parseRow, type ApprovalRow } from './journal-row';
import { wrap } from './journal-shared';
import type { ApprovalCommand, ApprovalCounts, ApprovalRecord } from './journal-types';

type CountsEffect = Effect.Effect<ApprovalCounts, JournalTransactionError>;
type CommandsEffect = Effect.Effect<readonly ApprovalCommand[], JournalTransactionError>;
type RecordEffect = Effect.Effect<ApprovalRecord | null, JournalTransactionError>;
type RecordsEffect = Effect.Effect<readonly ApprovalRecord[], JournalTransactionError>;
type BooleanEffect = Effect.Effect<boolean, JournalTransactionError>;
type DateEffect = Effect.Effect<Date | null, JournalTransactionError>;

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

const counts = (database: Database, now: Date): CountsEffect =>
  wrap('approvalCounts', () => {
    const row = database
      .query<
        { displayed: number; orphaned: number; pending: number; recently_resolved: number },
        [string]
      >(
        `SELECT SUM(state = 'Pending') AS pending,
           SUM(state = 'Pending' AND delivered_at IS NOT NULL) AS displayed,
           SUM(state = 'Orphaned') AS orphaned,
           SUM(state != 'Pending' AND resolved_at >= ?) AS recently_resolved
         FROM approval_requests`,
      )
      .get(new Date(now.getTime() - MILLISECONDS_PER_DAY).toISOString());
    return {
      displayed: row?.displayed ?? 0,
      orphaned: row?.orphaned ?? 0,
      pending: row?.pending ?? 0,
      recentlyResolved: row?.recently_resolved ?? 0,
    } satisfies ApprovalCounts;
  });

const listCommands = (
  database: Database,
  after: MessagesRowId,
  through: MessagesRowId,
): CommandsEffect =>
  wrap('listApprovalCommands', () =>
    database
      .query<{ id: string; sent_at: string; text: string }, [number, number]>(
        `SELECT im.id, im.sent_at, im.text FROM inbound_messages im
         WHERE im.text IS NOT NULL
           AND im.messages_rowid > ? AND im.messages_rowid <= ?
           AND NOT EXISTS (SELECT 1 FROM handled_approval_messages h WHERE h.inbound_message_id = im.id)
           AND NOT EXISTS (SELECT 1 FROM input_batch_messages b WHERE b.inbound_message_id = im.id)
           AND NOT EXISTS (SELECT 1 FROM scheduler_pool_messages p WHERE p.inbound_message_id = im.id)
         ORDER BY im.messages_rowid`,
      )
      .all(after, through)
      .filter((row) => parseApprovalCommand(row.text) !== null)
      .map((row) => ({
        id: InboundMessageId.make(row.id),
        sentAt: new Date(row.sent_at),
        text: row.text,
      })),
  );

const nextExpiryAt = (database: Database): DateEffect =>
  wrap('nextApprovalExpiry', () => {
    const row = database
      .query<{ expires_at: string | null }, []>(
        "SELECT MIN(expires_at) AS expires_at FROM approval_requests WHERE state = 'Pending'",
      )
      .get();
    return row?.expires_at === null || row?.expires_at === undefined
      ? null
      : new Date(row.expires_at);
  });

const hasRequest = (
  database: Database,
  connectionId: string,
  rpcRequestId: JsonRpcId,
): BooleanEffect =>
  wrap(
    'hasApprovalRequest',
    () =>
      database
        .query<{ present: number }, [string, string]>(
          `SELECT 1 AS present FROM approval_requests
         WHERE connection_id = ? AND rpc_request_id_json = ? LIMIT 1`,
        )
        .get(connectionId, JSON.stringify(rpcRequestId)) !== null,
  );

const listRecent = (database: Database, limit: number): RecordsEffect =>
  wrap('listApprovals', () =>
    database
      .query<ApprovalRow, [number]>(
        `SELECT * FROM approval_requests
         ORDER BY CASE WHEN state = 'Pending' THEN 0 ELSE 1 END, requested_at DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => parseRow(row)),
  );

const nextUndelivered = (database: Database): RecordEffect =>
  wrap('nextApproval', () => {
    const displayed = database
      .query<{ id: string }, []>(
        "SELECT id FROM approval_requests WHERE state = 'Pending' AND delivered_at IS NOT NULL LIMIT 1",
      )
      .get();
    if (displayed !== null) {
      return null;
    }
    const row = database
      .query<ApprovalRow, []>(
        "SELECT * FROM approval_requests WHERE state = 'Pending' ORDER BY requested_at LIMIT 1",
      )
      .get();
    return row === null ? null : parseRow(row);
  });

export { counts, hasRequest, listCommands, listRecent, nextExpiryAt, nextUndelivered };
