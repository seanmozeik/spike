import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Clock, Effect, Result } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, expect } from 'vitest';

import { openJournal } from '../src/database';
import { ChatGuid, MessageGuid, MessagesRowId } from '../src/domain/ids';
import type { ObservedMessage } from '../src/domain/inbound';
import { makeJournal } from '../src/journal/service';

const CHAT_GUID = ChatGuid.make('any;-;+15555550199');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const observed = (rowId: number, text = `message-${rowId}`): ObservedMessage => ({
  attachments: [],
  chatGuid: CHAT_GUID,
  handle: '+15555550199',
  messageGuid: MessageGuid.make(`guid-${rowId}`),
  rowId: MessagesRowId.make(rowId),
  sentAt: new Date('2026-07-14T12:00:00.000Z'),
  service: 'iMessage',
  text,
});

const makeDatabasePath = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-journal-'));
  roots.push(root);
  return path.join(root, 'spike.db');
};

it.effect('atomically persists inbound rows and cursor, dedupes, and resumes after restart', () =>
  Effect.gen(function* journalFixture() {
    const databasePath = makeDatabasePath();
    const firstHandle = yield* openJournal(databasePath);
    const first = makeJournal(firstHandle.database);
    expect(
      yield* first.ingestObservedMessages(CHAT_GUID, new Date(), [observed(2), observed(1)]),
    ).toBe(2);
    expect(
      yield* first.ingestObservedMessages(CHAT_GUID, new Date(), [observed(1), observed(2)]),
    ).toBe(0);
    expect((yield* first.inboxCursor(CHAT_GUID))?.lastRowId).toBe(2);
    firstHandle.close();

    const restartedHandle = yield* openJournal(databasePath);
    const restarted = makeJournal(restartedHandle.database);
    expect((yield* restarted.inboxCursor(CHAT_GUID))?.lastMessageGuid).toBe('guid-2');
    expect((yield* restarted.listInbound).map(({ rowId }) => rowId)).toStrictEqual([1, 2]);
    restartedHandle.close();
  }),
);

it.effect('rolls back inserted rows and cursor together when an observed batch is invalid', () =>
  Effect.gen(function* rollbackFixture() {
    const handle = yield* openJournal(makeDatabasePath());
    const journal = makeJournal(handle.database);
    const wrongChat = { ...observed(2), chatGuid: ChatGuid.make('chat-other') };
    const result = yield* Effect.result(
      journal.ingestObservedMessages(CHAT_GUID, new Date(), [observed(1), wrongChat]),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(yield* journal.listInbound).toStrictEqual([]);
    expect(yield* journal.inboxCursor(CHAT_GUID)).toBeNull();
    handle.close();
  }),
);

it.effect(
  'redacts copied payloads after 30 terminal days while preserving identity and state',
  () =>
    Effect.gen(function* retentionFixture() {
      const handle = yield* openJournal(makeDatabasePath());
      const journal = makeJournal(handle.database);
      const startedAt = yield* Clock.currentTimeMillis;
      yield* journal.ingestObservedMessages(CHAT_GUID, new Date(startedAt), [
        observed(1, 'private'),
      ]);
      const [inbound] = yield* journal.listInbound;
      expect(inbound).toBeDefined();
      if (inbound === undefined) {
        throw new Error('expected persisted inbound message');
      }
      handle.database.run(
        "INSERT INTO generations(id, sequence, state, created_at) VALUES ('generation', 1, 'Current', ?)",
        [new Date(startedAt).toISOString()],
      );
      handle.database.run(
        "INSERT INTO logical_turns VALUES ('turn', 'generation', 1, 'Running', 'correlation', ?, NULL, NULL)",
        [new Date(startedAt).toISOString()],
      );
      handle.database.run(
        "INSERT INTO input_batches VALUES ('batch', 'turn', 'Initial', 'fingerprint', ?)",
        [new Date(startedAt).toISOString()],
      );
      handle.database.run('INSERT INTO input_batch_messages VALUES (?, ?, 0)', [
        'batch',
        inbound.id,
      ]);
      yield* TestClock.adjust('31 days');
      const now = yield* Clock.currentTimeMillis;
      const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);
      const redactedAt = new Date(now);
      expect(yield* journal.redactTerminalPayloads(cutoff, redactedAt)).toBe(0);
      handle.database.run(
        "UPDATE logical_turns SET state = 'Completed', completed_at = ? WHERE id = 'turn'",
        [redactedAt.toISOString()],
      );
      handle.database.run(
        `INSERT INTO outbound_messages(
          id, logical_turn_id, source_kind, source_id, message_kind, text, state, created_at
        ) VALUES ('outbound', 'turn', 'LogicalTurn', 'turn', 'Final', 'done', 'Prepared', ?)`,
        [redactedAt.toISOString()],
      );
      expect(yield* journal.redactTerminalPayloads(cutoff, redactedAt)).toBe(0);
      handle.database.run(
        "UPDATE outbound_messages SET state = 'Delivered', delivered_at = ? WHERE id = 'outbound'",
        [redactedAt.toISOString()],
      );
      expect(yield* journal.redactTerminalPayloads(cutoff, redactedAt)).toBe(1);
      expect(yield* journal.listInbound).toMatchObject([
        { messageGuid: 'guid-1', rowId: 1, text: null },
      ]);
      handle.close();
    }),
);

it.effect('enforces one current generation and one batch assignment per inbound row', () =>
  Effect.gen(function* constraintsFixture() {
    const handle = yield* openJournal(makeDatabasePath());
    const journal = makeJournal(handle.database);
    yield* journal.ingestObservedMessages(CHAT_GUID, new Date(), [observed(1)]);
    const [inbound] = yield* journal.listInbound;
    if (inbound === undefined) {
      throw new Error('expected persisted inbound message');
    }
    handle.database.run(
      "INSERT INTO generations(id, sequence, state, created_at) VALUES ('generation', 1, 'Current', ?)",
      [new Date().toISOString()],
    );
    expect(() =>
      handle.database.run(
        "INSERT INTO generations(id, sequence, state, created_at) VALUES ('other-generation', 2, 'Current', ?)",
        [new Date().toISOString()],
      ),
    ).toThrow();
    handle.database.run(
      "INSERT INTO logical_turns VALUES ('turn', 'generation', 1, 'Collecting', 'correlation', ?, NULL, NULL)",
      [new Date().toISOString()],
    );
    handle.database.run(
      "INSERT INTO input_batches VALUES ('batch-1', 'turn', 'Initial', 'one', ?)",
      [new Date().toISOString()],
    );
    handle.database.run("INSERT INTO input_batches VALUES ('batch-2', 'turn', 'Steer', 'two', ?)", [
      new Date().toISOString(),
    ]);
    handle.database.run('INSERT INTO input_batch_messages VALUES (?, ?, 0)', [
      'batch-1',
      inbound.id,
    ]);
    expect(() =>
      handle.database.run('INSERT INTO input_batch_messages VALUES (?, ?, 0)', [
        'batch-2',
        inbound.id,
      ]),
    ).toThrow();
    handle.close();
  }),
);
