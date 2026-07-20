import type { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { MessagesRowId } from '../src/domain/ids';
import { makeJournal } from '../src/journal/service';
import { CHAT_GUID, inbound, makeEngineFixture, settle } from './engine-fixture';

const NOW = '2026-07-14T12:00:00.000Z';
const HANDLE = '+15555550199';

const seedCursor = (database: Database, rowId: number): void => {
  database.run(
    `INSERT INTO inbox_cursor(chat_guid, last_rowid, last_message_guid, updated_at)
     VALUES (?, ?, NULL, ?)`,
    [CHAT_GUID, rowId, NOW],
  );
};

const seedPersistedMessage = (database: Database): void => {
  seedCursor(database, 1);
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES ('persisted-old', 'message-old', 1, ?, ?, 'iMessage', 'survive process restart', ?, ?)`,
    [CHAT_GUID, HANDLE, NOW, NOW],
  );
};

it.effect('starts at floor zero and recovers persisted pre-boot work before advancing', () =>
  Effect.gen(function* startupFloorRecovery() {
    const fixture = yield* makeEngineFixture({
      prepare: (database) =>
        Effect.sync(() => {
          seedPersistedMessage(database);
        }),
    });
    expect(yield* fixture.engine.scanFloor).toBe(0);

    yield* settle(fixture.engine);
    expect(fixture.inputs).toStrictEqual(['survive process restart']);
    expect(yield* fixture.engine.scanFloor).toBe(1);

    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect(
  'processes an unclaimed message inside the floor window and reconfirms the frontier',
  () =>
    Effect.gen(function* midFloorPending() {
      const fixture = yield* makeEngineFixture({
        preexisting: [inbound(1, 'first request')],
        prepare: (database) =>
          Effect.sync(() => {
            seedCursor(database, 0);
          }),
      });
      yield* settle(fixture.engine);
      expect(yield* fixture.engine.scanFloor).toBe(1);

      fixture.database.run(`CREATE TEMP TRIGGER claim_row_three
      AFTER INSERT ON inbound_messages WHEN NEW.messages_rowid = 3
      BEGIN
        INSERT INTO handled_control_messages(inbound_message_id, command, handled_at)
        VALUES (NEW.id, '/status', '${NOW}');
      END`);
      fixture.push(inbound(2, 'mid-window request'), inbound(3, '/status'));
      yield* settle(fixture.engine);

      expect(fixture.inputs).toStrictEqual(['first request', 'mid-window request']);
      expect(yield* fixture.engine.scanFloor).toBe(3);
      yield* fixture.engine.shutdown;
      fixture.remove();
    }),
);

it.effect('leaves the floor unchanged when dispatch fails and schedules recovery work', () =>
  Effect.gen(function* failedPhaseFloor() {
    const fixture = yield* makeEngineFixture({
      behavior: { startFailure: 'scripted start failure' },
      phaseRetryMs: 10,
      preexisting: [inbound(1, 'failing request')],
      prepare: (database) =>
        Effect.sync(() => {
          seedCursor(database, 0);
        }),
    });
    yield* fixture.engine.pollOnce;

    expect(yield* fixture.engine.scanFloor).toBe(0);
    const failureCount = fixture.database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM failures')
      .get()?.count;
    expect(failureCount).toBeGreaterThan(0);
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('bounds recovery by rowid while preserving every durable claim exclusion', () =>
  Effect.gen(function* boundedRecoveryQuery() {
    const fixture = yield* makeEngineFixture();
    const journal = makeJournal(fixture.database, { chatGuid: CHAT_GUID, handle: HANDLE });
    yield* journal.ingestObservedMessages(CHAT_GUID, new Date(NOW), [
      inbound(1, 'input batch'),
      inbound(2, 'scheduler pool'),
      inbound(3, '/status'),
      inbound(4, '/no'),
      inbound(5, 'still pending'),
    ]);
    const rows = yield* journal.listInbound;
    const id = (rowId: number): string => {
      const row = rows.find((message) => message.rowId === rowId);
      if (row === undefined) {
        throw new Error(`missing inbound row ${String(rowId)}`);
      }
      return row.id;
    };
    const generation = fixture.database
      .query<{ id: string }, []>("SELECT id FROM generations WHERE state = 'Current'")
      .get()?.id;
    if (generation === undefined) {
      throw new Error('missing current generation');
    }
    fixture.database.run(
      "INSERT INTO logical_turns VALUES ('turn', ?, 1, 'Collecting', 'claim', ?, NULL, NULL)",
      [generation, NOW],
    );
    fixture.database.run(
      "INSERT INTO input_batches VALUES ('batch', 'turn', 1, 'Initial', 'claim', ?)",
      [NOW],
    );
    fixture.database.run("INSERT INTO input_batch_messages VALUES ('batch', ?, 0)", [id(1)]);
    fixture.database.run('INSERT INTO scheduler_pool_messages VALUES (?, 0)', [id(2)]);
    fixture.database.run("INSERT INTO handled_control_messages VALUES (?, '/status', ?)", [
      id(3),
      NOW,
    ]);
    fixture.database.run(
      "INSERT INTO handled_approval_messages VALUES (?, NULL, '/no', 'NoPending', ?)",
      [id(4), NOW],
    );

    const pending = yield* journal.listPendingInbound(MessagesRowId.make(0), MessagesRowId.make(5));
    expect(pending.messages.map(({ text }) => text)).toStrictEqual(['still pending']);
    expect(
      yield* journal.listPendingInbound(MessagesRowId.make(5), MessagesRowId.make(5)),
    ).toStrictEqual({ blocked: false, controls: [], messages: [] });
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);
