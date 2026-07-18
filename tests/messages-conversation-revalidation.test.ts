import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { expect } from 'vitest';

import { makeConversationPolicy } from '../src/conversation-policy';
import { openJournal } from '../src/database';
import { openMessagesTransport } from '../src/delivery/messages-transport';
import { makeConversationDiagnostic } from '../src/journal/conversation-diagnostic';
import { openMessagesInbox } from '../src/messages-inbox';
import {
  replaceMessagesDatabase,
  TEST_CHAT_GUID,
  TEST_HANDLE,
  withMessagesFixture,
} from './messages-fixture';

const STARTED_AT = new Date('2026-07-18T12:00:00.000Z');

it.effect('stays unavailable when Messages replaces chat.db between validated handle opens', () =>
  withMessagesFixture((messages) =>
    Effect.acquireUseRelease(
      openJournal(path.join(messages.root, 'spike.db')),
      (journal) =>
        Effect.acquireUseRelease(
          openMessagesInbox({
            chatGuid: TEST_CHAT_GUID,
            databasePath: messages.databasePath,
            handle: TEST_HANDLE,
          }),
          (inbox) =>
            Effect.acquireUseRelease(
              openMessagesTransport(messages.databasePath, {
                chatGuid: TEST_CHAT_GUID,
                handle: TEST_HANDLE,
              }),
              (transport) =>
                Effect.gen(function* replacementBetweenOpens() {
                  let replaceBetweenOpens = true;
                  const policy = yield* makeConversationPolicy({
                    diagnostic: makeConversationDiagnostic(journal.database),
                    initialValidationAt: STARTED_AT,
                    probe: () =>
                      inbox.refresh.pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            if (replaceBetweenOpens) {
                              replaceMessagesDatabase(messages, (database) => {
                                database
                                  .query('UPDATE chat SET service_name = ? WHERE guid = ?')
                                  .run('SMS', TEST_CHAT_GUID);
                              });
                            }
                          }),
                        ),
                        Effect.andThen(transport.refresh),
                      ),
                  });

                  expect(yield* policy.revalidate(STARTED_AT, 'Startup')).toBe(false);
                  expect(yield* policy.isAvailable).toBe(false);
                  expect(Result.isFailure(yield* Effect.result(transport.refresh))).toBe(true);

                  replaceBetweenOpens = false;
                  replaceMessagesDatabase(messages);
                  const recoveredAt = new Date(STARTED_AT.getTime() + 1);
                  expect(yield* policy.revalidate(recoveredAt, 'DatabaseChanged')).toBe(true);
                  expect(yield* policy.isAvailable).toBe(true);
                  policy.close();
                }),
              (transport) => Effect.sync(transport.close),
            ),
          (inbox) => Effect.sync(inbox.close),
        ),
      (journal) => Effect.sync(journal.close),
    ),
  ),
);
