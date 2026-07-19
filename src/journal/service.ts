import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import { makeAttachmentStore } from '../attachments/store';
import { belongsToConversation, type ConfiguredConversation } from '../conversation-guard';
import { MessagesRowId, type ChatGuid } from '../domain/ids';
import type { ObservedMessage } from '../domain/inbound';
import { journalTransactionError, tryJournalTransaction } from '../errors';
import { makeAuditStagedAttachments } from './attachment-audit';
import { makeStagePendingAttachments } from './attachment-staging';
import { makeListPendingControls } from './control-recovery';
import { makeAdvanceInboxCursor, makeInitializeInboxCursor } from './cursor';
import { makeListPendingInbound } from './inbound-recovery';
import { newestMessage } from './observed-messages';
import { makeRedact } from './retention';
import type {
  InboxCursor,
  Journal,
  JournalOptions,
  PersistedInboundMessage,
} from './service-types';

interface CursorRow {
  readonly chat_guid: string;
  readonly last_message_guid: null | string;
  readonly last_rowid: number;
  readonly updated_at: string;
}

interface InboundRow {
  readonly id: string;
  readonly message_guid: string;
  readonly messages_rowid: number;
  readonly text: null | string;
}

interface AttachmentOwnerRow {
  readonly inbound_message_id: string;
}

type PersistAttachments = (inboundId: string, message: ObservedMessage, observedAt: string) => void;
type PersistMessage = (message: ObservedMessage, observedAt: string) => number;
type IngestTransaction = (observedAt: string, messages: readonly ObservedMessage[]) => number;

const INSERT_MESSAGE = `INSERT OR IGNORE INTO inbound_messages(
  id, source_kind, source_id, message_guid, messages_rowid, chat_guid, handle,
  service, text, sent_at, observed_at
) VALUES (?, 'Messages', ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_ATTACHMENT = `INSERT OR IGNORE INTO attachments(
  id, inbound_message_id, attachment_guid, state, filename, transfer_name,
  mime_type, uti, total_bytes, source_path, ordinal, created_at
) VALUES (?, ?, ?, 'Observed', ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_CURSOR = `INSERT INTO inbox_cursor(chat_guid, last_rowid, last_message_guid, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(chat_guid) DO UPDATE SET
    last_rowid = MAX(inbox_cursor.last_rowid, excluded.last_rowid),
    last_message_guid = CASE
      WHEN excluded.last_rowid >= inbox_cursor.last_rowid THEN excluded.last_message_guid
      ELSE inbox_cursor.last_message_guid
    END,
    updated_at = excluded.updated_at`;
const REDACTION_ERROR = 'failed to redact terminal payloads';

const makePersistAttachments = (database: Database): PersistAttachments => {
  const insertAttachment = database.prepare<
    never,
    [
      string,
      string,
      string,
      null | string,
      null | string,
      null | string,
      null | string,
      null | number,
      null | string,
      number,
      string,
    ]
  >(INSERT_ATTACHMENT);
  const findOwner = database.prepare<AttachmentOwnerRow, [string]>(
    'SELECT inbound_message_id FROM attachments WHERE attachment_guid = ?',
  );
  return (inboundId, message, observedAt) => {
    for (const [ordinal, attachment] of message.attachments.entries()) {
      const result = insertAttachment.run(
        randomUUID(),
        inboundId,
        attachment.attachmentGuid,
        attachment.filename,
        attachment.transferName,
        attachment.mimeType,
        attachment.uti,
        attachment.totalBytes,
        attachment.filename,
        ordinal,
        observedAt,
      );
      const owner =
        result.changes === 1
          ? inboundId
          : findOwner.get(attachment.attachmentGuid)?.inbound_message_id;
      if (owner !== inboundId) {
        throw new Error(
          `attachment ${attachment.attachmentGuid} belongs to another inbound message`,
        );
      }
    }
  };
};

const makePersistMessage = (database: Database): PersistMessage => {
  const insertMessage = database.prepare<
    never,
    [string, string, string, number, string, string, string, null | string, string, string]
  >(INSERT_MESSAGE);
  const findInbound = database.prepare<{ id: string }, [string]>(
    "SELECT id FROM inbound_messages WHERE source_kind = 'Messages' AND message_guid = ?",
  );
  const persistAttachments = makePersistAttachments(database);
  return (message: ObservedMessage, observedAt: string): number => {
    const inboundId = randomUUID();
    const result = insertMessage.run(
      inboundId,
      message.messageGuid,
      message.messageGuid,
      message.rowId,
      message.chatGuid,
      message.handle,
      message.service,
      message.text,
      message.sentAt.toISOString(),
      observedAt,
    );
    const persistedId = result.changes === 1 ? inboundId : findInbound.get(message.messageGuid)?.id;
    if (persistedId === undefined) {
      throw new Error(`dedupe conflict for ${message.messageGuid}`);
    }
    persistAttachments(persistedId, message, observedAt);
    return result.changes;
  };
};

const makeIngest = (
  database: Database,
  conversation: ConfiguredConversation,
): IngestTransaction => {
  const persistMessage = makePersistMessage(database);
  return database.transaction(
    (observedAt: string, messages: readonly ObservedMessage[]): number => {
      for (const message of messages) {
        if (!belongsToConversation(conversation, message)) {
          throw new Error(
            `message ${message.messageGuid} does not belong to the configured conversation`,
          );
        }
      }
      let inserted = 0;
      for (const message of messages) {
        inserted += persistMessage(message, observedAt);
      }
      const newest = newestMessage(messages);
      if (newest !== null) {
        database.run(UPSERT_CURSOR, [
          conversation.chatGuid,
          newest.rowId,
          newest.messageGuid,
          observedAt,
        ]);
      }
      return inserted;
    },
  );
};

const readCursor = (database: Database, chatGuid: ChatGuid): InboxCursor | null => {
  const row = database
    .query<CursorRow, [string]>(
      `SELECT chat_guid, last_rowid, last_message_guid, updated_at
     FROM inbox_cursor WHERE chat_guid = ?`,
    )
    .get(chatGuid);
  return row === null
    ? null
    : {
        chatGuid: row.chat_guid,
        lastMessageGuid: row.last_message_guid,
        lastRowId: row.last_rowid,
        updatedAt: row.updated_at,
      };
};

const readInbound = (database: Database): readonly PersistedInboundMessage[] =>
  database
    .query<InboundRow, []>(
      `SELECT id, message_guid, messages_rowid, text
       FROM inbound_messages
       WHERE source_kind = 'Messages'
       ORDER BY messages_rowid ASC`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      messageGuid: row.message_guid,
      rowId: row.messages_rowid,
      text: row.text,
    }));

const makeAttachmentOperations = (
  database: Database,
  { attachmentStaging }: JournalOptions,
): {
  readonly audit: Journal['auditStagedAttachments'];
  readonly redact: ReturnType<typeof makeRedact>;
  readonly stage: Journal['stagePendingAttachments'];
} => {
  if (attachmentStaging === undefined) {
    return { audit: Effect.succeed(0), redact: makeRedact(database), stage: Effect.succeed(0) };
  }
  const store = makeAttachmentStore(attachmentStaging.stagingRoot);
  return {
    audit: makeAuditStagedAttachments(database, store),
    redact: makeRedact(database, store),
    stage: makeStagePendingAttachments(database, attachmentStaging, store),
  };
};

const makeJournal = (
  database: Database,
  conversation: ConfiguredConversation,
  options: JournalOptions = {},
): Journal => {
  const advanceInboxCursor = makeAdvanceInboxCursor(database);
  const ingest = makeIngest(database, conversation);
  const attachments = makeAttachmentOperations(database, options);
  return {
    advanceInboxCursor: (chatGuid, frontier, advancedAt) =>
      chatGuid === conversation.chatGuid
        ? advanceInboxCursor(chatGuid, frontier, advancedAt)
        : Effect.fail(
            journalTransactionError(
              'advanceInboxCursor',
              'idle cursor target does not match the configured conversation',
              new Error('configured conversation mismatch'),
            ),
          ),
    auditStagedAttachments: attachments.audit,
    inboxCursor: (chatGuid) => Effect.sync(() => readCursor(database, chatGuid)),
    ingestObservedMessages: (chatGuid, observedAt, messages) =>
      tryJournalTransaction(
        'ingestObservedMessages',
        'failed to atomically persist observed Messages rows and cursor',
        () => {
          if (chatGuid !== conversation.chatGuid) {
            throw new Error('ingest target does not match the configured conversation');
          }
          return ingest(observedAt.toISOString(), messages);
        },
      ),
    initializeInboxCursor: makeInitializeInboxCursor(database),
    listInbound: Effect.sync(() => readInbound(database)),
    listPendingControls: makeListPendingControls(database)(),
    listPendingInbound: makeListPendingInbound(database),
    redactTerminalPayloads: (cutoff, redactedAt) =>
      tryJournalTransaction('redactTerminalPayloads', REDACTION_ERROR, () =>
        attachments.redact(cutoff.toISOString(), redactedAt.toISOString()),
      ),
    stagePendingAttachments: attachments.stage,
  };
};

const cursorRowId = (cursor: InboxCursor | null): MessagesRowId =>
  MessagesRowId.make(cursor?.lastRowId ?? 0);

export { cursorRowId, makeJournal };
export type {
  InboxCursor,
  Journal,
  JournalOptions,
  PersistedInboundMessage,
} from './service-types';
