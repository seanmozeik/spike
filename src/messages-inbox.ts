import type { Database, Statement } from 'bun:sqlite';
import { Buffer } from 'node:buffer';

import { Effect } from 'effect';

import { ChatGuid, MessageGuid, MessagesRowId } from './domain/ids';
import type { ObservedAttachment, ObservedMessage } from './domain/inbound';
import { ConversationMismatchError, MessagesPermissionError, MessagesQueryError } from './errors';
import { openValidatedMessagesDatabase, type MessagesDatabaseOptions } from './messages-database';
import {
  ATTACHMENT_QUERY,
  FRONTIER_QUERY,
  IDLE_FRONTIER_QUERY,
  MESSAGE_QUERY,
} from './messages-inbox-query';

type MessagesInboxOptions = MessagesDatabaseOptions;

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
  readonly scanAfter: (
    cursor: MessagesRowId,
  ) => Effect.Effect<InboxScan, MessagesPermissionError | MessagesQueryError>;
  readonly refresh: Effect.Effect<
    void,
    ConversationMismatchError | MessagesPermissionError | MessagesQueryError
  >;
}

interface InboxScan {
  readonly frontier: MessagesRowId;
  readonly messages: readonly ObservedMessage[];
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
const ENCODED_LENGTH_BYTES = new Map<number, number>([
  [TWO_BYTE_LENGTH, TWO_BYTES],
  [FOUR_BYTE_LENGTH, FOUR_BYTES],
  [EIGHT_BYTE_LENGTH, EIGHT_BYTES],
]);

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

const mapMessage = (
  row: MessageRow,
  attachmentQuery: Statement<AttachmentRow, [number]>,
): ObservedMessage => ({
  attachments: attachmentQuery.all(row.rowid).map((attachment) => attachmentFromRow(attachment)),
  chatGuid: ChatGuid.make(row.chat_guid),
  handle: row.handle_id,
  isFromMe: false,
  messageGuid: MessageGuid.make(row.message_guid),
  rowId: MessagesRowId.make(row.rowid),
  sentAt: new Date(row.unix_ms),
  service: 'iMessage',
  text: row.text ?? decodeAttributedBody(row.attributed_body),
});

interface InboxConnection {
  readonly database: Database;
  readonly frontier: Statement<{ rowid: number }, [number, string, string]>;
  readonly scanAfter: (cursor: MessagesRowId, chatGuid: string, handle: string) => InboxScan;
}

interface InboxState {
  closed: boolean;
  connection: InboxConnection;
}

const makeConnection = (database: Database): InboxConnection => {
  const attachments = database.prepare<AttachmentRow, [number]>(ATTACHMENT_QUERY);
  const idleFrontier = database.prepare<{ rowid: number }, [number, string]>(IDLE_FRONTIER_QUERY);
  const messages = database.prepare<MessageRow, [number, string, string]>(MESSAGE_QUERY);
  const scanAfter = database.transaction(
    (cursor: MessagesRowId, chatGuid: string, handle: string): InboxScan => {
      const observed = messages
        .all(cursor, chatGuid, handle)
        .map((row) => mapMessage(row, attachments));
      const newest = observed.at(-1);
      const frontier =
        newest?.rowId ?? MessagesRowId.make(idleFrontier.get(cursor, chatGuid)?.rowid ?? cursor);
      return { frontier, messages: observed };
    },
  );
  return {
    database,
    frontier: database.prepare<{ rowid: number }, [number, string, string]>(FRONTIER_QUERY),
    scanAfter,
  };
};

const openDatabase = (options: MessagesInboxOptions): Database =>
  openValidatedMessagesDatabase(options);

const makeRefresh = (
  state: InboxState,
  options: MessagesInboxOptions,
): MessagesInboxHandle['refresh'] =>
  Effect.try({
    catch: (cause) =>
      cause instanceof ConversationMismatchError
        ? cause
        : accessError(options, 'refresh-configured-conversation', cause),
    try: () => {
      if (state.closed) {
        throw new Error('Messages inbox is closed');
      }
      const replacement = openDatabase(options);
      try {
        const next = makeConnection(replacement);
        state.connection.database.close();
        state.connection = next;
      } catch (error) {
        replacement.close();
        throw error;
      }
    },
  });

const makeInbox = (database: Database, options: MessagesInboxOptions): MessagesInboxHandle => {
  const state: InboxState = { closed: false, connection: makeConnection(database) };
  const scanAfter = (
    cursor: MessagesRowId,
  ): Effect.Effect<InboxScan, MessagesPermissionError | MessagesQueryError> =>
    Effect.try({
      catch: (cause) => accessError(options, 'scan-after', cause),
      try: () => state.connection.scanAfter(cursor, options.chatGuid, options.handle),
    });
  return {
    close: () => {
      if (state.closed) {
        return;
      }
      state.closed = true;
      state.connection.database.close();
    },
    frontier: Effect.try({
      catch: (cause) => accessError(options, 'frontier', cause),
      try: () =>
        MessagesRowId.make(
          state.connection.frontier.get(0, options.chatGuid, options.handle)?.rowid ?? 0,
        ),
    }),
    refresh: makeRefresh(state, options),
    scanAfter,
  };
};

const openMessagesInbox = Effect.fn('MessagesInbox.open')((options: MessagesInboxOptions) =>
  Effect.try({
    catch: (cause) =>
      cause instanceof ConversationMismatchError
        ? cause
        : new MessagesPermissionError({
            cause,
            databasePath: options.databasePath,
            message:
              'Spike cannot open chat.db read-only. Grant Full Disk Access to the Bun executable that runs spike.',
          }),
    try: () => openDatabase(options),
  }).pipe(
    Effect.flatMap((database) =>
      Effect.try({
        catch: (cause) => {
          database.close();
          return cause instanceof ConversationMismatchError
            ? cause
            : accessError(options, 'validate-configured-conversation', cause);
        },
        try: () => {
          return makeInbox(database, options);
        },
      }),
    ),
  ),
);

export { decodeAttributedBody, openMessagesInbox };
export type { InboxScan, MessagesInboxHandle, MessagesInboxOptions };
