import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import type { StagedImageAttachment } from '../attachments/model';
import { parseControlCommand } from '../domain/control-command';
import { InboundMessageId } from '../domain/ids';
import { JournalTransactionError } from '../errors';
import {
  attachmentInputTextSql,
  readStagedImages,
  renderPersistedInputText,
} from './attachment-input';

interface PendingInboundMessage {
  readonly acknowledgementText: null | string;
  readonly attachments: readonly StagedImageAttachment[];
  readonly id: InboundMessageId;
  readonly receivedAt: Date;
  readonly text: string;
}

interface PendingInboundRow {
  readonly attachment_text: null | string;
  readonly has_observed_attachment: number;
  readonly id: string;
  readonly observed_at: string;
  readonly text: null | string;
}

const toTrustedControlMessage = (row: PendingInboundRow): PendingInboundMessage => ({
  acknowledgementText: row.text,
  attachments: [],
  id: InboundMessageId.make(row.id),
  receivedAt: new Date(row.observed_at),
  text: row.text ?? '',
});

const PENDING_INBOUND_PREDICATE = `NOT EXISTS (
  SELECT 1 FROM input_batch_messages ibm WHERE ibm.inbound_message_id = im.id
) AND NOT EXISTS (
  SELECT 1 FROM scheduler_pool_messages spm WHERE spm.inbound_message_id = im.id
) AND NOT EXISTS (
  SELECT 1 FROM handled_control_messages hcm WHERE hcm.inbound_message_id = im.id
) AND NOT EXISTS (
  SELECT 1 FROM handled_approval_messages ham WHERE ham.inbound_message_id = im.id
)`;

const readPendingInboundRows = (database: Database): readonly PendingInboundRow[] =>
  database
    .query<PendingInboundRow, []>(
      `SELECT im.id, im.text, im.observed_at,
              MAX(CASE WHEN a.state = 'Observed' THEN 1 ELSE 0 END)
                AS has_observed_attachment,
              ${attachmentInputTextSql} AS attachment_text
       FROM inbound_messages im
       LEFT JOIN attachments a ON a.inbound_message_id = im.id
       WHERE ${PENDING_INBOUND_PREDICATE}
       GROUP BY im.id, im.text, im.observed_at, im.messages_rowid
       ORDER BY im.messages_rowid`,
    )
    .all();

const toOrdinaryMessage = (database: Database, row: PendingInboundRow): PendingInboundMessage => ({
  acknowledgementText: row.text,
  attachments: readStagedImages(database, row.id),
  id: InboundMessageId.make(row.id),
  receivedAt: new Date(row.observed_at),
  text: renderPersistedInputText({ attachmentText: row.attachment_text, text: row.text }),
});

const dispatchableMessages = (
  database: Database,
  rows: readonly PendingInboundRow[],
): readonly PendingInboundMessage[] => {
  const messages: PendingInboundMessage[] = [];
  let ordinaryBlocked = false;
  for (const row of rows) {
    if (parseControlCommand(row.text) !== null) {
      messages.push(toTrustedControlMessage(row));
    } else if (!ordinaryBlocked && row.has_observed_attachment > 0) {
      ordinaryBlocked = true;
    } else if (!ordinaryBlocked) {
      const message = toOrdinaryMessage(database, row);
      if (message.text.trim().length > 0) {
        messages.push(message);
      }
    }
  }
  return messages;
};

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
      try: () => dispatchableMessages(database, readPendingInboundRows(database)),
    });

export { makeListPendingInbound };
export type { PendingInboundMessage };
