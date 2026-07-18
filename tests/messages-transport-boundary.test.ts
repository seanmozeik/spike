import type { Database } from 'bun:sqlite';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { expect } from 'vitest';

import { openJournal, type JournalHandle } from '../src/database';
import { MessagesDeliveryError } from '../src/delivery/error';
import { makeDeliveryJournal } from '../src/delivery/journal';
import { openMessagesTransport, type MessagesTransport } from '../src/delivery/messages-transport';
import type { PreparedDelivery } from '../src/delivery/model';
import { makeDeliveryService } from '../src/delivery/service';
import type { SpikeRuntimeError } from '../src/errors';
import {
  attributedBody,
  TEST_CHAT_GUID,
  type MessagesFixture,
  withMessagesFixture,
} from './messages-fixture';

interface TransportFixture {
  readonly messages: MessagesFixture;
  readonly transport: MessagesTransport;
}

const withTransportFixture = <A, E, R>(
  use: (fixture: TransportFixture) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MessagesDeliveryError, R> =>
  withMessagesFixture((messages) =>
    Effect.acquireUseRelease(
      openMessagesTransport(messages.databasePath, TEST_CHAT_GUID),
      (transport) => use({ messages, transport }),
      (transport) => Effect.sync(transport.close),
    ),
  );

const withJournal = <A, E, R>(
  messages: MessagesFixture,
  use: (handle: JournalHandle) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SpikeRuntimeError, R> =>
  Effect.acquireUseRelease(openJournal(path.join(messages.root, 'spike.db')), use, (handle) =>
    Effect.sync(handle.close),
  );

const onlyChunk = (prepared: PreparedDelivery): PreparedDelivery['chunks'][number] => {
  const [chunk] = prepared.chunks;
  if (chunk === undefined) {
    throw new Error('expected one prepared delivery chunk');
  }
  return chunk;
};

const withSend = (
  transport: MessagesTransport,
  send: MessagesTransport['send'],
): MessagesTransport => ({ ...transport, send });

const outboundState = (database: Database): string | undefined =>
  database.query<{ state: string }, []>('SELECT state FROM outbound_messages').get()?.state;

const attemptState = (database: Database): string | undefined =>
  database.query<{ state: string }, []>('SELECT state FROM delivery_attempts').get()?.state;

it.effect('selects the configured-chat frontier from the real fixture database', () =>
  withTransportFixture(({ messages, transport }) =>
    Effect.gen(function* frontierFixture() {
      messages.insertMessage({ guid: 'configured-inbound', rowId: 4, text: 'inbound' });
      messages.insertMessage({
        chatId: 3,
        guid: 'other-chat-later',
        isFromMe: true,
        rowId: 99,
        text: 'other',
      });
      messages.insertMessage({
        guid: 'configured-outbound',
        isFromMe: true,
        rowId: 7,
        text: 'sent',
      });
      expect(yield* transport.frontier).toBe(7);
    }),
  ),
);

it.effect(
  'finds the earliest exact outbound match after the frontier and ignores ineligible rows',
  () =>
    withTransportFixture(({ messages, transport }) =>
      Effect.gen(function* matchingFixture() {
        messages.insertMessage({
          guid: 'before-frontier',
          isFromMe: true,
          rowId: 5,
          text: 'exact',
        });
        messages.insertMessage({
          chatId: 3,
          guid: 'other-chat',
          isFromMe: true,
          rowId: 11,
          text: 'exact',
        });
        messages.insertMessage({ guid: 'inbound', rowId: 12, text: 'exact' });
        messages.insertMessage({
          guid: 'outbound-sms',
          isFromMe: true,
          rowId: 13,
          service: 'SMS',
          text: 'exact',
        });
        messages.insertMessage({
          attributedBody: attributedBody('attributed exact'),
          guid: 'attributed',
          isFromMe: true,
          rowId: 14,
        });
        messages.insertMessage({ guid: 'first-exact', isFromMe: true, rowId: 15, text: 'exact' });
        messages.insertMessage({
          guid: 'ambiguous-later',
          isFromMe: true,
          rowId: 16,
          text: 'exact',
        });
        expect(yield* transport.findMatchingAfter(10, 'exact')).toStrictEqual({
          guid: 'first-exact',
          rowId: 15,
        });
        expect(yield* transport.findMatchingAfter(10, 'attributed exact')).toStrictEqual({
          guid: 'attributed',
          rowId: 14,
        });
        expect(yield* transport.findMatchingAfter(16, 'exact')).toBeNull();
        expect(yield* transport.findMatchingAfter(0, 'missing')).toBeNull();
      }),
    ),
);

it.effect('returns typed open and reconciliation failures', () =>
  withTransportFixture(({ messages, transport }) =>
    Effect.gen(function* typedFailureFixture() {
      const openFailure = yield* Effect.result(
        openMessagesTransport(path.join(messages.root, 'missing', 'chat.db'), TEST_CHAT_GUID),
      );
      expect(Result.isFailure(openFailure)).toBe(true);
      if (Result.isFailure(openFailure)) {
        expect(openFailure.failure).toBeInstanceOf(MessagesDeliveryError);
        expect(openFailure.failure.operation).toBe('open');
      }
      messages.database.run('DROP TABLE chat_message_join');
      const reconcileFailure = yield* Effect.result(transport.findMatchingAfter(0, 'anything'));
      expect(Result.isFailure(reconcileFailure)).toBe(true);
      if (Result.isFailure(reconcileFailure)) {
        expect(reconcileFailure.failure).toBeInstanceOf(MessagesDeliveryError);
        expect(reconcileFailure.failure.operation).toBe('reconcile');
      }
    }),
  ),
);

it.effect('sends a prepared pre-restart chunk once and confirms it through chat.db', () =>
  withTransportFixture(({ messages, transport }) =>
    withJournal(messages, (handle) =>
      Effect.gen(function* preparedRestartFixture() {
        const journal = makeDeliveryJournal(handle.database);
        yield* journal.prepareControlMessage(
          'prepared-restart',
          'Send after restart',
          new Date('2026-07-18T12:00:00.000Z'),
        );
        let sends = 0;
        const service = makeDeliveryService(
          journal,
          withSend(transport, (text) =>
            Effect.sync(() => {
              sends += 1;
              messages.insertMessage({
                guid: 'sent-after-restart',
                isFromMe: true,
                rowId: 1,
                text,
              });
            }),
          ),
        );
        yield* service.recover;
        expect(sends).toBe(1);
        expect(outboundState(handle.database)).toBe('Delivered');
        expect(attemptState(handle.database)).toBe('Reconciled');
      }),
    ),
  ),
);

it.effect('reconciles an unknown pre-restart attempt without resending', () =>
  withTransportFixture(({ messages, transport }) =>
    withJournal(messages, (handle) =>
      Effect.gen(function* confirmedRestartFixture() {
        const journal = makeDeliveryJournal(handle.database);
        const prepared = yield* journal.prepareControlMessage(
          'unknown-restart',
          'Already sent',
          new Date('2026-07-18T12:00:00.000Z'),
        );
        const chunk = onlyChunk(prepared);
        const attemptId = yield* journal.beginAttempt(
          chunk.id,
          20,
          new Date('2026-07-18T12:00:01.000Z'),
        );
        yield* journal.markAttemptUnknown(
          attemptId,
          'process exited',
          new Date('2026-07-18T12:00:02.000Z'),
        );
        messages.insertMessage({
          guid: 'confirmed-after-frontier',
          isFromMe: true,
          rowId: 21,
          text: chunk.text,
        });
        let sends = 0;
        const service = makeDeliveryService(
          journal,
          withSend(transport, () =>
            Effect.sync(() => {
              sends += 1;
            }),
          ),
        );
        yield* service.recover;
        expect(sends).toBe(0);
        expect(outboundState(handle.database)).toBe('Delivered');
        expect(attemptState(handle.database)).toBe('Reconciled');
      }),
    ),
  ),
);

it.effect('does not resend an unknown attempt when only a pre-frontier match exists', () =>
  withTransportFixture(({ messages, transport }) =>
    withJournal(messages, (handle) =>
      Effect.gen(function* missingRestartFixture() {
        const journal = makeDeliveryJournal(handle.database);
        const prepared = yield* journal.prepareControlMessage(
          'missing-restart',
          'Before the frontier',
          new Date('2026-07-18T12:00:00.000Z'),
        );
        const chunk = onlyChunk(prepared);
        const attemptId = yield* journal.beginAttempt(
          chunk.id,
          20,
          new Date('2026-07-18T12:00:01.000Z'),
        );
        yield* journal.markAttemptUnknown(
          attemptId,
          'process exited',
          new Date('2026-07-18T12:00:02.000Z'),
        );
        messages.insertMessage({
          guid: 'match-before-frontier',
          isFromMe: true,
          rowId: 20,
          text: chunk.text,
        });
        let sends = 0;
        const service = makeDeliveryService(
          journal,
          withSend(transport, () =>
            Effect.sync(() => {
              sends += 1;
            }),
          ),
        );
        yield* service.recover;
        expect(sends).toBe(0);
        expect(outboundState(handle.database)).toBe('Failed');
        expect(attemptState(handle.database)).toBe('Failed');
      }),
    ),
  ),
);
