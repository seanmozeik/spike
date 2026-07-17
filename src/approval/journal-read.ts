import type { Database } from 'bun:sqlite';

import type { Effect } from 'effect';

import { InboundMessageId } from '../domain/ids';
import type { JournalTransactionError } from '../errors';
import { parseRow, type ApprovalRow } from './journal-row';
import { wrap } from './journal-shared';
import type { ApprovalCommand, ApprovalCounts, ApprovalRecord } from './journal-types';

type CountsEffect = Effect.Effect<ApprovalCounts, JournalTransactionError>;
type CommandsEffect = Effect.Effect<readonly ApprovalCommand[], JournalTransactionError>;
type RecordEffect = Effect.Effect<ApprovalRecord | null, JournalTransactionError>;
type RecordsEffect = Effect.Effect<readonly ApprovalRecord[], JournalTransactionError>;

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

const listCommands = (database: Database): CommandsEffect =>
  wrap('listApprovalCommands', () =>
    database
      .query<{ id: string; text: string }, []>(
        `SELECT im.id, im.text FROM inbound_messages im
         WHERE im.text IS NOT NULL
           AND (lower(trim(im.text)) GLOB '/yes*' OR lower(trim(im.text)) GLOB '/no*')
           AND NOT EXISTS (SELECT 1 FROM handled_approval_messages h WHERE h.inbound_message_id = im.id)
           AND NOT EXISTS (SELECT 1 FROM input_batch_messages b WHERE b.inbound_message_id = im.id)
           AND NOT EXISTS (SELECT 1 FROM scheduler_pool_messages p WHERE p.inbound_message_id = im.id)
         ORDER BY im.messages_rowid`,
      )
      .all()
      .map((row) => ({ id: InboundMessageId.make(row.id), text: row.text })),
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

export { counts, listCommands, listRecent, nextUndelivered };
