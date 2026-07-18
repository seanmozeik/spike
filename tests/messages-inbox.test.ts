import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { expect } from 'vitest';

import { MessagesRowId } from '../src/domain/ids';
import { ConversationMismatchError } from '../src/errors';
import { decodeAttributedBody, openMessagesInbox } from '../src/messages-inbox';
import {
  attributedBody,
  replaceMessagesDatabase,
  TEST_CHAT_GUID as CHAT_GUID,
  TEST_HANDLE as HANDLE,
  type MessagesFixture,
  withMessagesFixture,
} from './messages-fixture';

const seedInboxMessages = (fixture: MessagesFixture): void => {
  fixture.insertMessage({ guid: 'valid-text', rowId: 1, text: 'hello' });
  fixture.insertMessage({ chatId: 2, guid: 'group', rowId: 2, text: 'group' });
  fixture.insertMessage({ guid: 'sms', rowId: 3, service: 'SMS', text: 'sms' });
  fixture.insertMessage({ chatId: 3, guid: 'other-dm', handleId: 2, rowId: 4, text: 'other' });
  fixture.insertMessage({ guid: 'outbound', isFromMe: true, rowId: 5, text: 'sent by Spike' });
  fixture.insertMessage({
    attributedBody: attributedBody('fallback text'),
    guid: 'typedstream',
    rowId: 6,
  });
  fixture.insertMessage({ guid: 'attachment-only', hasAttachments: true, rowId: 7 });
  fixture.addAttachment({
    filename: '/tmp/photo.jpg',
    guid: 'attachment-guid',
    messageRowId: 7,
    mimeType: 'image/jpeg',
    rowId: 1,
    totalBytes: 123,
    transferName: 'photo.jpg',
    uti: 'public.jpeg',
  });
};

it.effect('observes only ordered inbound iMessage rows from the configured conversation', () =>
  withMessagesFixture((fixture) =>
    Effect.gen(function* messagesFixture() {
      seedInboxMessages(fixture);
      const inbox = yield* openMessagesInbox({
        chatGuid: CHAT_GUID,
        databasePath: fixture.databasePath,
        handle: HANDLE,
      });
      try {
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
      } finally {
        inbox.close();
      }
    }),
  ),
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
  withMessagesFixture((fixture) =>
    Effect.gen(function* mismatchFixture() {
      const result = yield* Effect.result(
        openMessagesInbox({
          chatGuid: 'chat-other',
          databasePath: fixture.databasePath,
          handle: HANDLE,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(ConversationMismatchError);
      }
    }),
  ),
);

it.effect('rejects a style-45 conversation with more than one participant', () =>
  withMessagesFixture((fixture) =>
    Effect.gen(function* multiParticipantFixture() {
      const result = yield* Effect.result(
        openMessagesInbox({
          chatGuid: 'chat-two-participants',
          databasePath: fixture.databasePath,
          handle: HANDLE,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(ConversationMismatchError);
      }
    }),
  ),
);

it.effect('revalidates group, canonical handle, and service changes and recovers exactly', () =>
  withMessagesFixture((fixture) =>
    Effect.gen(function* changedBoundaryFixture() {
      const inbox = yield* openMessagesInbox({
        chatGuid: CHAT_GUID,
        databasePath: fixture.databasePath,
        handle: HANDLE,
      });
      const cases = [
        {
          invalidate: (): void => {
            fixture.database.run('UPDATE chat SET style = 43 WHERE ROWID = 1');
            fixture.database.run('INSERT INTO chat_handle_join VALUES (1, 2)');
          },
          restore: (): void => {
            fixture.database.run(
              'DELETE FROM chat_handle_join WHERE chat_id = 1 AND handle_id = 2',
            );
            fixture.database.run('UPDATE chat SET style = 45 WHERE ROWID = 1');
          },
        },
        {
          invalidate: (): void => {
            fixture.database.run('UPDATE chat_handle_join SET handle_id = 2 WHERE chat_id = 1');
          },
          restore: (): void => {
            fixture.database.run('UPDATE chat_handle_join SET handle_id = 1 WHERE chat_id = 1');
          },
        },
        {
          invalidate: (): void => {
            fixture.database.run("UPDATE handle SET service = 'SMS' WHERE ROWID = 1");
            fixture.database.run("UPDATE chat SET service_name = 'SMS' WHERE ROWID = 1");
          },
          restore: (): void => {
            fixture.database.run("UPDATE handle SET service = 'iMessage' WHERE ROWID = 1");
            fixture.database.run("UPDATE chat SET service_name = 'iMessage' WHERE ROWID = 1");
          },
        },
      ] as const;
      try {
        for (const boundaryCase of cases) {
          boundaryCase.invalidate();
          const invalid = yield* Effect.result(inbox.refresh);
          expect(Result.isFailure(invalid)).toBe(true);
          if (Result.isFailure(invalid)) {
            expect(invalid.failure).toBeInstanceOf(ConversationMismatchError);
          }
          boundaryCase.restore();
          yield* inbox.refresh;
        }
      } finally {
        inbox.close();
      }
    }),
  ),
);

it.effect('reopens a replaced Messages database before accepting its boundary', () =>
  withMessagesFixture((fixture) =>
    Effect.gen(function* replacedDatabaseFixture() {
      const inbox = yield* openMessagesInbox({
        chatGuid: CHAT_GUID,
        databasePath: fixture.databasePath,
        handle: HANDLE,
      });
      try {
        replaceMessagesDatabase(fixture, (database) => {
          database.run('UPDATE chat SET style = 43 WHERE ROWID = 1');
        });
        const invalid = yield* Effect.result(inbox.refresh);
        expect(Result.isFailure(invalid)).toBe(true);
        if (Result.isFailure(invalid)) {
          expect(invalid.failure).toBeInstanceOf(ConversationMismatchError);
        }

        replaceMessagesDatabase(fixture);
        yield* inbox.refresh;
        expect(yield* inbox.frontier).toBe(0);
      } finally {
        inbox.close();
      }
    }),
  ),
);

it('decodes the NSString typedstream fallback conservatively', () => {
  expect(decodeAttributedBody(attributedBody('hello'))).toBe('hello');
  const longText = 'a long outbound reply '.repeat(16);
  expect(new TextEncoder().encode(longText).length).toBeGreaterThan(255);
  expect(decodeAttributedBody(attributedBody(longText))).toBe(longText);
  expect(decodeAttributedBody(new Uint8Array([1, 2, 3]))).toBeNull();
});
