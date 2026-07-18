import type { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { makeDeliveryJournal } from '../src/delivery/journal';
import { MessageGuid, MessagesRowId } from '../src/domain/ids';
import type { ObservedMessage } from '../src/domain/inbound';
import { ConversationMismatchError } from '../src/errors';
import { makeJournal } from '../src/journal/service';
import { CHAT_GUID, makeEngineFixture, settle } from './engine-fixture';

const STARTED_AT = new Date('2026-07-18T12:00:00.000Z');

const inbound = (rowId: number, text: string): ObservedMessage => ({
  attachments: [],
  chatGuid: CHAT_GUID,
  handle: '+15555550199',
  isFromMe: false,
  messageGuid: MessageGuid.make(`startup-${rowId}`),
  rowId: MessagesRowId.make(rowId),
  sentAt: STARTED_AT,
  service: 'iMessage',
  text,
});

const countRows = (database: Database, table: string): number =>
  database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0;

const seedActiveTurnWithPool = (database: Database): void => {
  const now = STARTED_AT.toISOString();
  const observedAt = new Date(STARTED_AT.getTime() - 10_000).toISOString();
  database.run(
    "INSERT INTO generations VALUES ('generation', 1, 'Current', ?, NULL, 'thread-1', NULL, NULL)",
    [now],
  );
  database.run(
    "INSERT INTO logical_turns VALUES ('logical-turn', 'generation', 1, 'Running', 'correlation', ?, NULL, NULL)",
    [now],
  );
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES ('pooled-message', 'pooled-guid', 1, ?, '+15555550199', 'iMessage', ?, ?, ?)`,
    [CHAT_GUID, 'persisted follow-up', observedAt, observedAt],
  );
  database.run(
    `INSERT INTO scheduler_state(
       singleton, generation_id, active_logical_turn_id, active_codex_turn_id,
       active_acknowledged, timer_deadline_at, updated_at
     ) VALUES (1, 'generation', 'logical-turn', 'turn-1', 0, ?, ?)`,
    [observedAt, now],
  );
  database.run("INSERT INTO scheduler_pool_messages VALUES ('pooled-message', 0)");
};

it.effect(
  'fails closed before startup recovery or inbox ingestion and resumes after validation',
  () =>
    Effect.gen(function* startupBoundary() {
      let valid = false;
      const fixture = yield* makeEngineFixture({
        conversationProbe: () =>
          valid
            ? Effect.void
            : Effect.fail(
                new ConversationMismatchError({
                  chatGuid: CHAT_GUID,
                  handle: '+15555550199',
                  message: 'startup conversation mismatch',
                }),
              ),
        now: () => STARTED_AT,
        preexisting: [inbound(1, 'do not ingest before startup validation')],
        prepare: (database) =>
          Effect.gen(function* prepareStartupRecovery() {
            yield* makeJournal(database, {
              chatGuid: CHAT_GUID,
              handle: '+15555550199',
            }).initializeInboxCursor(CHAT_GUID, MessagesRowId.make(0), STARTED_AT);
            yield* makeDeliveryJournal(database).prepareControlMessage(
              'startup-recovery',
              'recover only after validation',
              STARTED_AT,
            );
          }),
      });

      yield* settle(fixture.engine);
      expect(fixture.sent).toStrictEqual([]);
      expect(fixture.inputs).toStrictEqual([]);
      const inboundBeforeRecovery = countRows(fixture.database, 'inbound_messages');
      expect(inboundBeforeRecovery).toBe(0);

      valid = true;
      const recoveredAt = new Date(STARTED_AT.getTime() + 1);
      expect(yield* fixture.conversation.revalidate(recoveredAt, 'DatabaseChanged')).toBe(true);
      yield* settle(fixture.engine);
      expect(fixture.sent).toContain('recover only after validation');
      const inboundAfterRecovery = countRows(fixture.database, 'inbound_messages');
      expect(inboundAfterRecovery).toBe(1);

      yield* fixture.engine.shutdown;
      fixture.remove();
    }),
);

it.effect('keeps a persisted active-turn pool inert until exact startup recovery', () =>
  Effect.gen(function* guardedSchedulerRecovery() {
    const gate = Promise.withResolvers<undefined>();
    let valid = false;
    const fixture = yield* makeEngineFixture({
      behavior: { gate: gate.promise },
      conversationProbe: () =>
        valid
          ? Effect.void
          : Effect.fail(
              new ConversationMismatchError({
                chatGuid: CHAT_GUID,
                handle: '+15555550199',
                message: 'startup conversation mismatch',
              }),
            ),
      now: () => STARTED_AT,
      prepare: (database) =>
        Effect.sync(() => {
          seedActiveTurnWithPool(database);
        }),
      snapshot: { id: 'thread-1', turns: [{ id: 'turn-1', items: [], status: 'inProgress' }] },
    });

    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(10));
    expect(fixture.steers).toStrictEqual([]);
    expect((yield* fixture.engine.snapshot).pool).toHaveLength(1);
    expect(countRows(fixture.database, 'scheduler_pool_messages')).toBe(1);

    valid = true;
    const recoveredAt = new Date(STARTED_AT.getTime() + 1);
    expect(yield* fixture.conversation.revalidate(recoveredAt, 'DatabaseChanged')).toBe(true);
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(10));
    expect(fixture.steers).toStrictEqual(['persisted follow-up']);
    expect((yield* fixture.engine.snapshot).pool).toStrictEqual([]);
    expect(countRows(fixture.database, 'scheduler_pool_messages')).toBe(0);

    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(10));
    expect(fixture.steers).toStrictEqual(['persisted follow-up']);

    gate.resolve();
    yield* fixture.engine.drain;
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);
