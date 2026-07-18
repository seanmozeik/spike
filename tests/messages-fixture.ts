import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';

const TEST_CHAT_GUID = 'any;-;+15555550199';
const TEST_HANDLE = '+15555550199';
const OTHER_HANDLE = '+15555550198';
const BYTE_BASE = 256;
const TWO_BYTE_LENGTH = 0x81;
const ONE_BYTE_MAX_LENGTH = 127;
const FIXTURE_YEAR = 2026;
const FIXTURE_MONTH = 6;
const FIXTURE_DAY = 14;
const FIXTURE_HOUR = 12;
const APPLE_EPOCH_MILLISECONDS = 978_307_200_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const APPLE_NOW =
  (Date.UTC(FIXTURE_YEAR, FIXTURE_MONTH, FIXTURE_DAY, FIXTURE_HOUR) - APPLE_EPOCH_MILLISECONDS) *
  NANOSECONDS_PER_MILLISECOND;

interface FixtureMessage {
  readonly attributedBody?: null | Uint8Array;
  readonly chatId?: number;
  readonly date?: number;
  readonly guid: string;
  readonly handleId?: number;
  readonly hasAttachments?: boolean;
  readonly isFromMe?: boolean;
  readonly rowId: number;
  readonly service?: string;
  readonly text?: null | string;
}

interface FixtureAttachment {
  readonly filename?: null | string;
  readonly guid: string;
  readonly messageRowId: number;
  readonly mimeType?: null | string;
  readonly rowId: number;
  readonly totalBytes?: null | number;
  readonly transferName?: null | string;
  readonly uti?: null | string;
}

interface MessagesFixture {
  readonly addAttachment: (attachment: FixtureAttachment) => void;
  readonly close: () => void;
  readonly database: Database;
  readonly databasePath: string;
  readonly insertMessage: (message: FixtureMessage) => void;
  readonly root: string;
}

const attributedBody = (text: string): Uint8Array => {
  const prefix = new TextEncoder().encode('typedstream NSString+');
  const value = new TextEncoder().encode(text);
  const length =
    value.length <= ONE_BYTE_MAX_LENGTH
      ? [value.length]
      : [TWO_BYTE_LENGTH, value.length % BYTE_BASE, Math.floor(value.length / BYTE_BASE)];
  return new Uint8Array([...prefix, ...length, ...value]);
};

const createSchema = (database: Database): void => {
  for (const statement of [
    'CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, style INTEGER NOT NULL)',
    'CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL)',
    'CREATE TABLE chat_handle_join (chat_id INTEGER NOT NULL, handle_id INTEGER NOT NULL)',
    `CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, text TEXT, attributedBody BLOB,
      date REAL NOT NULL, is_from_me INTEGER NOT NULL, cache_has_attachments INTEGER NOT NULL,
      service TEXT NOT NULL, handle_id INTEGER NOT NULL
    )`,
    'CREATE TABLE chat_message_join (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL)',
    `CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, filename TEXT, mime_type TEXT,
      transfer_name TEXT, uti TEXT, total_bytes INTEGER
    )`,
    'CREATE TABLE message_attachment_join (message_id INTEGER NOT NULL, attachment_id INTEGER NOT NULL)',
  ]) {
    database.run(statement);
  }
};

const seedConversations = (database: Database): void => {
  database.run('INSERT INTO handle VALUES (1, ?), (2, ?)', [TEST_HANDLE, OTHER_HANDLE]);
  database.run(
    "INSERT INTO chat VALUES (1, ?, 45), (2, 'chat-group', 43), (3, 'chat-other', 45), (4, 'chat-two-participants', 45)",
    [TEST_CHAT_GUID],
  );
  database.run('INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (3, 2), (4, 1), (4, 2)');
};

const initializeDatabase = (database: Database): void => {
  createSchema(database);
  seedConversations(database);
};

const makeInsertMessage =
  (database: Database) =>
  (message: FixtureMessage): void => {
    database.run(
      `INSERT INTO message(
       ROWID, guid, text, attributedBody, date, is_from_me,
       cache_has_attachments, service, handle_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.rowId,
        message.guid,
        message.text ?? null,
        message.attributedBody ?? null,
        message.date ?? APPLE_NOW,
        message.isFromMe === true ? 1 : 0,
        message.hasAttachments === true ? 1 : 0,
        message.service ?? 'iMessage',
        message.handleId ?? 1,
      ],
    );
    database.run('INSERT INTO chat_message_join(chat_id, message_id) VALUES (?, ?)', [
      message.chatId ?? 1,
      message.rowId,
    ]);
  };

const makeAddAttachment =
  (database: Database) =>
  (attachment: FixtureAttachment): void => {
    database.run('INSERT INTO attachment VALUES (?, ?, ?, ?, ?, ?, ?)', [
      attachment.rowId,
      attachment.guid,
      attachment.filename ?? null,
      attachment.mimeType ?? null,
      attachment.transferName ?? null,
      attachment.uti ?? null,
      attachment.totalBytes ?? null,
    ]);
    database.run('INSERT INTO message_attachment_join VALUES (?, ?)', [
      attachment.messageRowId,
      attachment.rowId,
    ]);
  };

const releaseMessagesRoot = (root: string, database: Database | undefined): void => {
  try {
    database?.close();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

const makeMessagesFixture = (
  initialize: (database: Database) => void = initializeDatabase,
): MessagesFixture => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-chat-'));
  let database: Database | undefined;
  try {
    const databasePath = path.join(root, 'chat.db');
    const openedDatabase = new Database(databasePath, { create: true, strict: true });
    database = openedDatabase;
    initialize(openedDatabase);
    let closed = false;
    return {
      addAttachment: makeAddAttachment(openedDatabase),
      close: (): void => {
        if (closed) {
          return;
        }
        closed = true;
        releaseMessagesRoot(root, openedDatabase);
      },
      database: openedDatabase,
      databasePath,
      insertMessage: makeInsertMessage(openedDatabase),
      root,
    };
  } catch (error) {
    releaseMessagesRoot(root, database);
    throw error;
  }
};

const withMessagesFixture = <A, E, R>(
  use: (fixture: MessagesFixture) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(Effect.sync(makeMessagesFixture), use, (fixture) =>
    Effect.sync(fixture.close),
  );

export { attributedBody, makeMessagesFixture, TEST_CHAT_GUID, TEST_HANDLE, withMessagesFixture };
export type { FixtureAttachment, FixtureMessage, MessagesFixture };
