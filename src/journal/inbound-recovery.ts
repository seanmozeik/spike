import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import { InboundMessageId } from '../domain/ids';
import { JournalTransactionError } from '../errors';

interface PendingInboundMessage {
  readonly acknowledgementText: null | string;
  readonly id: InboundMessageId;
  readonly receivedAt: Date;
  readonly text: string;
}

interface PendingInboundRow {
  readonly attachment_text: null | string;
  readonly id: string;
  readonly observed_at: string;
  readonly text: null | string;
}

const renderPendingText = (row: PendingInboundRow): string =>
  [row.text, row.attachment_text].filter((part): part is string => part !== null).join('\n');

const makeListPendingInbound =
  (database: Database) =>
  (): Effect.Effect<readonly PendingInboundMessage[], JournalTransactionError> =>
    Effect.try({
      catch: (cause) =>
        new JournalTransactionError({
          cause,
          message: 'failed to load unassigned inbound messages',
          transaction: 'listPendingInbound',
        }),
      try: () =>
        database
          .query<PendingInboundRow, []>(
            `SELECT im.id, im.text, im.observed_at,
                    GROUP_CONCAT(
                      '[Attachment: ' || COALESCE(a.filename, a.transfer_name, a.attachment_guid) ||
                      CASE WHEN a.mime_type IS NULL THEN '' ELSE ' (' || a.mime_type || ')' END || ']'
                    , char(10)) AS attachment_text
             FROM inbound_messages im
             LEFT JOIN attachments a ON a.inbound_message_id = im.id
             WHERE NOT EXISTS (
               SELECT 1 FROM input_batch_messages ibm WHERE ibm.inbound_message_id = im.id
             ) AND NOT EXISTS (
               SELECT 1 FROM scheduler_pool_messages spm WHERE spm.inbound_message_id = im.id
             ) AND NOT EXISTS (
               SELECT 1 FROM handled_control_messages hcm WHERE hcm.inbound_message_id = im.id
             )
             GROUP BY im.id, im.text, im.observed_at, im.messages_rowid
             ORDER BY im.messages_rowid`,
          )
          .all()
          .map((row) => ({
            acknowledgementText: row.text,
            id: InboundMessageId.make(row.id),
            receivedAt: new Date(row.observed_at),
            text: renderPendingText(row),
          }))
          .filter((message) => message.text.trim().length > 0),
    });

export { makeListPendingInbound };
export type { PendingInboundMessage };
