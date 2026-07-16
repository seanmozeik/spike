import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { afterEach, expect } from 'vitest';

import { MessagesRowId } from '../src/domain/ids';
import { ConversationMismatchError } from '../src/errors';
import { decodeAttributedBody, openMessagesInbox } from '../src/messages-inbox';

const CHAT_GUID = 'any;-;+15555550199';
const HANDLE = '+15555550199';
const BYTE_BASE = 256;
const TWO_BYTE_LENGTH = 0x81;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const attributedBody = (text: string): Uint8Array => {
  const prefix = new TextEncoder().encode('typedstream NSString+');
  const value = new TextEncoder().encode(text);
  const length =
    value.length <= 127
      ? [value.length]
      : [TWO_BYTE_LENGTH, value.length % BYTE_BASE, Math.floor(value.length / BYTE_BASE)];
  return new Uint8Array([...prefix, ...length, ...value]);
};

const createMessagesFixture = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-chat-'));
  roots.push(root);
  const databasePath = path.join(root, 'chat.db');
  const database = new Database(databasePath, { create: true, strict: true });
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
  database.run("INSERT INTO handle VALUES (1, ?), (2, '+15555550198')", [HANDLE]);
  database.run(
    "INSERT INTO chat VALUES (1, ?, 45), (2, 'chat-group', 43), (3, 'chat-other', 45), (4, 'chat-two-participants', 45)",
    [CHAT_GUID],
  );
  database.run('INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (3, 2), (4, 1), (4, 2)');
  const appleNow = (Date.UTC(2026, 6, 14, 12) - 978_307_200_000) * 1_000_000;
  const insert = database.prepare<
    never,
    [number, string, null | string, null | Uint8Array, number, number, number, string, number]
  >('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run(1, 'valid-text', 'hello', null, appleNow, 0, 0, 'iMessage', 1);
  insert.run(2, 'group', 'group', null, appleNow, 0, 0, 'iMessage', 1);
  insert.run(3, 'sms', 'sms', null, appleNow, 0, 0, 'SMS', 1);
  insert.run(4, 'other-dm', 'other', null, appleNow, 0, 0, 'iMessage', 2);
  insert.run(5, 'outbound', 'sent by Spike', null, appleNow, 1, 0, 'iMessage', 1);
  insert.run(
    6,
    'typedstream',
    null,
    attributedBody('fallback text'),
    appleNow,
    0,
    0,
    'iMessage',
    1,
  );
  insert.run(7, 'attachment-only', null, null, appleNow, 0, 1, 'iMessage', 1);
  database.run('INSERT INTO chat_message_join VALUES (1,1),(2,2),(1,3),(3,4),(1,5),(1,6),(1,7)');
  database.run(
    "INSERT INTO attachment VALUES (1, 'attachment-guid', '/tmp/photo.jpg', 'image/jpeg', 'photo.jpg', 'public.jpeg', 123)",
  );
  database.run('INSERT INTO message_attachment_join VALUES (7,1)');
  database.close();
  return databasePath;
};

it.effect('observes only ordered inbound iMessage rows from the configured conversation', () =>
  Effect.gen(function* messagesFixture() {
    const databasePath = createMessagesFixture();
    const inbox = yield* openMessagesInbox({ chatGuid: CHAT_GUID, databasePath, handle: HANDLE });
    expect(yield* inbox.frontier).toBe(7);
    const messages = yield* inbox.observeAfter(MessagesRowId.make(0));
    expect(messages.map(({ messageGuid }) => messageGuid)).toStrictEqual([
      'valid-text',
      'typedstream',
      'attachment-only',
    ]);
    expect(messages[1]?.text).toBe('fallback text');
    expect(messages[2]?.attachments).toStrictEqual([
      {
        attachmentGuid: 'attachment-guid',
        filename: '/tmp/photo.jpg',
        mimeType: 'image/jpeg',
        totalBytes: 123,
        transferName: 'photo.jpg',
        uti: 'public.jpeg',
      },
    ]);
    expect(
      (yield* inbox.observeAfter(MessagesRowId.make(6))).map(({ rowId }) => rowId),
    ).toStrictEqual([7]);
    inbox.close();
  }),
);

it.effect('returns a visible Full Disk Access error when chat.db cannot be opened', () =>
  Effect.gen(function* permissionFixture() {
    const result = yield* Effect.result(
      openMessagesInbox({
        chatGuid: CHAT_GUID,
        databasePath: '/definitely/missing/chat.db',
        handle: HANDLE,
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain('Full Disk Access');
    }
  }),
);

it.effect('rejects a configured chat that is not the exact direct conversation', () =>
  Effect.gen(function* mismatchFixture() {
    const result = yield* Effect.result(
      openMessagesInbox({
        chatGuid: 'chat-other',
        databasePath: createMessagesFixture(),
        handle: HANDLE,
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ConversationMismatchError);
    }
  }),
);

it.effect('rejects a style-45 conversation with more than one participant', () =>
  Effect.gen(function* multiParticipantFixture() {
    const result = yield* Effect.result(
      openMessagesInbox({
        chatGuid: 'chat-two-participants',
        databasePath: createMessagesFixture(),
        handle: HANDLE,
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ConversationMismatchError);
    }
  }),
);

it('decodes the NSString typedstream fallback conservatively', () => {
  expect(decodeAttributedBody(attributedBody('hello'))).toBe('hello');
  const longText = 'a long outbound reply '.repeat(16);
  expect(new TextEncoder().encode(longText).length).toBeGreaterThan(255);
  expect(decodeAttributedBody(attributedBody(longText))).toBe(longText);
  expect(decodeAttributedBody(new Uint8Array([1, 2, 3]))).toBeNull();
});
