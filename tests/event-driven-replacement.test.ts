import type { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, vi } from 'vitest';

import { ConversationMismatchError } from '../src/errors';
import { openMessagesInbox } from '../src/messages-inbox';
import { makeMessagesWatcher } from '../src/messages-watcher';
import { CHAT_GUID, inbound, makeEngineFixture, type EngineFixture } from './engine-fixture';
import {
  insertFixtureMessage,
  replaceMessagesDatabase,
  TEST_CHAT_GUID,
  TEST_HANDLE,
  withMessagesFixture,
} from './messages-fixture';
import { makeWatcherHarness } from './messages-watcher-harness';

const cursorRow = (database: Database): { readonly last_rowid: number } | null =>
  database.query<{ last_rowid: number }, []>('SELECT last_rowid FROM inbox_cursor').get();

const waitFor = (assertion: () => void): Effect.Effect<void> =>
  Effect.promise(() => vi.waitFor(assertion));

const shutdown = (
  fixture: EngineFixture,
  run: Fiber.Fiber<never, unknown>,
): Effect.Effect<void, unknown> =>
  fixture.engine.shutdown.pipe(
    Effect.andThen(Fiber.interrupt(run)),
    Effect.andThen(
      Effect.sync(() => {
        fixture.remove();
      }),
    ),
  );

it.effect('reopens a valid replacement chat.db before the event-driven scan', () =>
  withMessagesFixture((messages) =>
    Effect.acquireUseRelease(
      openMessagesInbox({
        chatGuid: TEST_CHAT_GUID,
        databasePath: messages.databasePath,
        handle: TEST_HANDLE,
      }),
      (inbox) =>
        Effect.gen(function* replacementIngestion() {
          const fixture = yield* makeEngineFixture({
            conversationProbe: () => inbox.refresh,
            inbox,
            messagesDebounceMs: 5,
            reconcileIntervalMs: 60_000,
            watchMessages: makeMessagesWatcher(messages.databasePath),
          });
          const run = yield* Effect.forkChild(fixture.engine.run);
          yield* Effect.promise(() =>
            vi.waitFor(() => {
              expect(cursorRow(fixture.database)).toStrictEqual({ last_rowid: 0 });
            }),
          );

          replaceMessagesDatabase(messages, (database) => {
            insertFixtureMessage(database, {
              guid: 'replacement-message',
              rowId: 1,
              text: 'replacement arrived',
            });
          });
          yield* Effect.promise(() =>
            vi.waitFor(() => {
              expect(fixture.inputs).toContain('replacement arrived');
            }),
          );

          yield* shutdown(fixture, run);
        }),
      (inbox) => Effect.sync(inbox.close),
    ),
  ),
);

it.effect('retains reconciliation when a coalesced replacement refresh fails', () =>
  Effect.gen(function* retainReconciliation() {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const watcher = makeWatcherHarness();
    let now = new Date('2026-07-14T12:00:00.000Z');
    let probes = 0;
    let valid = true;
    const fixture = yield* makeEngineFixture({
      conversationProbe: () => {
        probes += 1;
        return valid
          ? Effect.void
          : Effect.fail(
              new ConversationMismatchError({
                chatGuid: CHAT_GUID,
                handle: TEST_HANDLE,
                message: 'replacement conversation mismatch',
              }),
            );
      },
      conversationValidationIntervalMs: 10,
      messagesDebounceMs: 5,
      now: () => now,
      onInboxScan: (scan) =>
        scan === 2
          ? Effect.promise(() => {
              entered.resolve();
              return release.promise;
            })
          : Effect.void,
      phaseRetryMs: 10,
      reconcileIntervalMs: 10,
      watchMessages: watcher.open,
    });
    const run = yield* Effect.forkChild(fixture.engine.run);
    yield* waitFor(() => {
      expect(fixture.inboxScans).toBe(1);
    });
    fixture.push(inbound(1, 'hold the ingestion phase'));
    watcher.dirty();
    yield* Effect.promise(() => entered.promise);

    valid = false;
    now = new Date(now.getTime() + 10);
    watcher.replace();
    yield* Effect.promise(() => Bun.sleep(20));
    yield* TestClock.adjust('10 millis');
    release.resolve();
    yield* waitFor(() => {
      expect(probes).toBeGreaterThanOrEqual(2);
    });
    yield* Effect.promise(() => Bun.sleep(20));

    valid = true;
    now = new Date(now.getTime() + 10);
    yield* TestClock.adjust('10 millis');
    yield* waitFor(() => {
      expect(fixture.inboxScans).toBeGreaterThanOrEqual(3);
    });
    fixture.push(inbound(2, 'missed after replacement retry'));
    now = new Date(now.getTime() + 10);
    yield* TestClock.adjust('10 millis');
    yield* waitFor(() => {
      expect(fixture.inputs).toContain('missed after replacement retry');
    });
    yield* shutdown(fixture, run);
  }),
);
