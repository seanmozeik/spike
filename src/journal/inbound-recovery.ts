import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import type { StagedImageAttachment } from '../attachments/model';
import { parseControlCommand } from '../domain/control-command';
import { InboundMessageId, type MessagesRowId } from '../domain/ids';
import { JournalTransactionError } from '../errors';
import { readStagedImages, renderPersistedInputText } from './attachment-input';
import { PENDING_INBOUND_QUERY } from './recovery-query';

interface PendingInboundMessage {
  readonly acknowledgementText: null | string;
  readonly attachments: readonly StagedImageAttachment[];
  readonly id: InboundMessageId;
  readonly receivedAt: Date;
  readonly text: string;
}

interface PendingInboundScan {
  readonly blocked: boolean;
  readonly controls: readonly PendingInboundMessage[];
  readonly messages: readonly PendingInboundMessage[];
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

const readPendingInboundRows = (
  database: Database,
  after: MessagesRowId,
  through: MessagesRowId,
): readonly PendingInboundRow[] =>
  database.query<PendingInboundRow, [number, number]>(PENDING_INBOUND_QUERY).all(after, through);

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
): PendingInboundScan => {
  const controls: PendingInboundMessage[] = [];
  const messages: PendingInboundMessage[] = [];
  let ordinaryBlocked = false;
  for (const row of rows) {
    if (parseControlCommand(row.text) !== null) {
      const control = toTrustedControlMessage(row);
      controls.push(control);
      messages.push(control);
    } else if (!ordinaryBlocked && row.has_observed_attachment > 0) {
      ordinaryBlocked = true;
    } else if (!ordinaryBlocked) {
      const message = toOrdinaryMessage(database, row);
      if (message.text.trim().length > 0) {
        messages.push(message);
      }
    }
  }
  return { blocked: ordinaryBlocked, controls, messages };
};

const makeListPendingInbound =
  (database: Database) =>
  (
    after: MessagesRowId,
    through: MessagesRowId,
  ): Effect.Effect<PendingInboundScan, JournalTransactionError> =>
    Effect.try({
      catch: (cause) =>
        new JournalTransactionError({
          cause,
          message: 'failed to load unassigned inbound messages',
          transaction: 'listPendingInbound',
        }),
      try: () => dispatchableMessages(database, readPendingInboundRows(database, after, through)),
    });

export { makeListPendingInbound };
export type { PendingInboundMessage, PendingInboundScan };
