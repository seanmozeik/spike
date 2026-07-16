import { Database, type Statement } from 'bun:sqlite';
import { Buffer } from 'node:buffer';

import { Effect } from 'effect';

import { ChatGuid, MessageGuid, MessagesRowId } from './domain/ids';
import type { ObservedAttachment, ObservedMessage } from './domain/inbound';
import { MessagesPermissionError, MessagesQueryError, SelfChatMismatchError } from './errors';

interface MessagesInboxOptions {
  readonly chatGuid: string;
  readonly databasePath: string;
  readonly handle: string;
}

interface ChatRow {
  readonly guid: string;
  readonly has_handle: number;
  readonly style: number;
}

interface MessageRow {
  readonly attributed_body: null | Uint8Array;
  readonly cache_has_attachments: number;
  readonly chat_guid: string;
  readonly handle_id: string;
  readonly message_guid: string;
  readonly rowid: number;
  readonly text: null | string;
  readonly unix_ms: number;
}

interface AttachmentRow {
  readonly attachment_guid: string;
  readonly filename: null | string;
  readonly mime_type: null | string;
  readonly total_bytes: null | number;
  readonly transfer_name: null | string;
  readonly uti: null | string;
}

interface MessagesInboxHandle {
  readonly close: () => void;
  readonly frontier: Effect.Effect<MessagesRowId, MessagesPermissionError | MessagesQueryError>;
  readonly observeAfter: (
    cursor: MessagesRowId,
  ) => Effect.Effect<readonly ObservedMessage[], MessagesPermissionError | MessagesQueryError>;
}

interface TypedLength {
  readonly length: number;
  readonly start: number;
}

const DIRECT_LENGTH_START = 2;
const ENCODED_LENGTH_START = 2;
const TWO_BYTE_LENGTH = 0x81;
const FOUR_BYTE_LENGTH = 0x82;
const EIGHT_BYTE_LENGTH = 0x83;
const TWO_BYTES = 2;
const FOUR_BYTES = 4;
const EIGHT_BYTES = 8;
const BYTE_BASE = 256;
const PLUS_BYTE = 43;
const SELF_CHAT_STYLE = 45;
const ENCODED_LENGTH_BYTES = new Map<number, number>([
  [TWO_BYTE_LENGTH, TWO_BYTES],
  [FOUR_BYTE_LENGTH, FOUR_BYTES],
  [EIGHT_BYTE_LENGTH, EIGHT_BYTES],
]);

const CHAT_QUERY = `SELECT c.guid, c.style,
  EXISTS(
    SELECT 1 FROM chat_handle_join chj
    JOIN handle h ON h.ROWID = chj.handle_id
    WHERE chj.chat_id = c.ROWID AND lower(h.id) = lower(?)
  ) AS has_handle
  FROM chat c WHERE c.guid = ?`;
const ATTACHMENT_QUERY = `SELECT a.guid AS attachment_guid, a.filename, a.mime_type,
  a.transfer_name, a.uti, a.total_bytes
  FROM attachment a JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
  WHERE maj.message_id = ? ORDER BY a.ROWID ASC`;
const MESSAGE_QUERY = `SELECT m.ROWID AS rowid, m.guid AS message_guid, m.text,
  m.attributedBody AS attributed_body, m.cache_has_attachments,
  (m.date / 1000000.0) + 978307200000.0 AS unix_ms,
  h.id AS handle_id, c.guid AS chat_guid
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID > ? AND c.guid = ? AND c.style = 45
    AND m.is_from_me = 0 AND m.service = 'iMessage' AND lower(h.id) = lower(?)
    AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
  ORDER BY m.ROWID ASC`;
const FRONTIER_QUERY = `SELECT COALESCE(MAX(m.ROWID), 0) AS rowid
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  JOIN handle h ON h.ROWID = m.handle_id
  WHERE c.guid = ? AND c.style = 45 AND m.is_from_me = 0 AND m.service = 'iMessage'
    AND lower(h.id) = lower(?)
    AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)`;

const readTypedLength = (body: Uint8Array, plus: number): TypedLength => {
  const prefix = body[plus + 1] ?? 0;
  const encodedBytes = ENCODED_LENGTH_BYTES.get(prefix) ?? 0;
  if (encodedBytes > 0) {
    let length = 0;
    for (let index = 0; index < encodedBytes; index += 1) {
      length += (body[plus + ENCODED_LENGTH_START + index] ?? 0) * BYTE_BASE ** index;
    }
    return { length, start: plus + ENCODED_LENGTH_START + encodedBytes };
  }
  return { length: prefix, start: plus + DIRECT_LENGTH_START };
};

const decodeAttributedBody = (body: null | Uint8Array): null | string => {
  if (body === null) {
    return null;
  }
  const marker = Buffer.from(body).indexOf('NSString');
  const plus = marker === -1 ? -1 : body.indexOf(PLUS_BYTE, marker);
  if (plus === -1 || plus + 1 >= body.length) {
    return null;
  }
  const { length, start } = readTypedLength(body, plus);
  if (length <= 0 || start + length > body.length) {
    return null;
  }
  const decoded = new TextDecoder()
    .decode(body.subarray(start, start + length))
    .replaceAll('\0', '');
  return decoded.trim() === '' ? null : decoded;
};

const attachmentFromRow = (row: AttachmentRow): ObservedAttachment => ({
  attachmentGuid: row.attachment_guid,
  filename: row.filename,
  mimeType: row.mime_type,
  totalBytes: row.total_bytes,
  transferName: row.transfer_name,
  uti: row.uti,
});

const queryError = (operation: string, cause: unknown): MessagesQueryError =>
  new MessagesQueryError({
    cause,
    message: `Messages database query failed during ${operation}`,
    operation,
  });

const isPermissionFailure = (cause: unknown): boolean => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /authorization denied|not authorized|operation not permitted|permission denied/iu.test(
    message,
  );
};

const accessError = (
  options: MessagesInboxOptions,
  operation: string,
  cause: unknown,
): MessagesPermissionError | MessagesQueryError =>
  isPermissionFailure(cause)
    ? new MessagesPermissionError({
        cause,
        databasePath: options.databasePath,
        message:
          'Spike lost access to chat.db. Grant Full Disk Access to the Bun executable that runs spike.',
      })
    : queryError(operation, cause);

const validateSelfChat = (database: Database, options: MessagesInboxOptions): void => {
  const chat = database
    .query<ChatRow, [string, string]>(CHAT_QUERY)
    .get(options.handle, options.chatGuid);
  if (chat?.style === SELF_CHAT_STYLE && chat.has_handle === 1) {
    return;
  }
  throw new SelfChatMismatchError({
    chatGuid: options.chatGuid,
    handle: options.handle,
    message: 'configured chat must be a one-to-one iMessage chat containing the configured handle',
  });
};

const mapMessage = (
  row: MessageRow,
  attachmentQuery: Statement<AttachmentRow, [number]>,
): ObservedMessage => ({
  attachments:
    row.cache_has_attachments === 1
      ? attachmentQuery.all(row.rowid).map((attachment) => attachmentFromRow(attachment))
      : [],
  chatGuid: ChatGuid.make(row.chat_guid),
  handle: row.handle_id,
  messageGuid: MessageGuid.make(row.message_guid),
  rowId: MessagesRowId.make(row.rowid),
  sentAt: new Date(row.unix_ms),
  service: 'iMessage',
  text: row.text ?? decodeAttributedBody(row.attributed_body),
});

const makeInbox = (database: Database, options: MessagesInboxOptions): MessagesInboxHandle => {
  const attachments = database.prepare<AttachmentRow, [number]>(ATTACHMENT_QUERY);
  const frontier = database.prepare<{ rowid: number }, [string, string]>(FRONTIER_QUERY);
  const messages = database.prepare<MessageRow, [number, string, string]>(MESSAGE_QUERY);
  const observeAfter = (
    cursor: MessagesRowId,
  ): Effect.Effect<readonly ObservedMessage[], MessagesPermissionError | MessagesQueryError> =>
    Effect.try({
      catch: (cause) => accessError(options, 'observe-after', cause),
      try: () =>
        messages
          .all(cursor, options.chatGuid, options.handle)
          .map((row) => mapMessage(row, attachments)),
    });
  return {
    close: () => {
      database.close();
    },
    frontier: Effect.try({
      catch: (cause) => accessError(options, 'frontier', cause),
      try: () => MessagesRowId.make(frontier.get(options.chatGuid, options.handle)?.rowid ?? 0),
    }),
    observeAfter,
  };
};

const openMessagesInbox = Effect.fn('MessagesInbox.open')((options: MessagesInboxOptions) =>
  Effect.try({
    catch: (cause) =>
      new MessagesPermissionError({
        cause,
        databasePath: options.databasePath,
        message:
          'Spike cannot open chat.db read-only. Grant Full Disk Access to the Bun executable that runs spike.',
      }),
    try: () => new Database(options.databasePath, { readonly: true, strict: true }),
  }).pipe(
    Effect.flatMap((database) =>
      Effect.try({
        catch: (cause) => {
          database.close();
          return cause instanceof SelfChatMismatchError
            ? cause
            : accessError(options, 'validate-self-chat', cause);
        },
        try: () => {
          validateSelfChat(database, options);
          return makeInbox(database, options);
        },
      }),
    ),
  ),
);

export { decodeAttributedBody, openMessagesInbox };
export type { MessagesInboxHandle, MessagesInboxOptions };
