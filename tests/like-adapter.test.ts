import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { openJournal } from '../src/database';
import { InboundMessageId } from '../src/domain/ids';
import { makeDisabledLikeAcknowledgement, makeLikeAcknowledgement } from '../src/like/adapter';
import { makeLikeJournal } from '../src/like/journal';
import {
  parseOutcome,
  type LikeNativeOutcome,
  type LikeNativeRunner,
} from '../src/like/native-runner';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const seedInbound = (database: Database, id: string, rowId: number, text: string): void => {
  const now = new Date().toISOString();
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (?, ?, ?, 'chat', 'handle', 'iMessage', ?, ?, ?)`,
    [id, `guid-${id}`, rowId, text, now, now],
  );
};

const outcomeRunner =
  (outcomes: readonly LikeNativeOutcome[], calls: string[]): LikeNativeRunner =>
  (text) =>
    Effect.sync(() => {
      calls.push(text);
      const outcome = outcomes[calls.length - 1];
      return outcome ?? { kind: 'failed', reason: 'missing fixture outcome' };
    });

it('parses only the native helper outcome envelope', () => {
  expect(parseOutcome('{"kind":"liked"}')).toEqual({ kind: 'liked' });
  expect(parseOutcome('{"kind":"skipped","reason":"locked"}')).toEqual({
    kind: 'skipped',
    reason: 'locked',
  });
  expect(() => parseOutcome('{"kind":"anything"}')).toThrow('unknown outcome');
});

it.effect('disables native Like work while retaining journal status', () =>
  Effect.gen(function* disabledLikeFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-like-disabled-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    seedInbound(handle.database, 'disabled-message', 1, 'first');
    const acknowledgement = makeDisabledLikeAcknowledgement(makeLikeJournal(handle.database));
    yield* acknowledgement.acknowledge(
      InboundMessageId.make('disabled-message'),
      'first',
      new Date(),
    );
    expect((yield* acknowledgement.status).available).toBe(false);
    expect(
      handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM like_attempts')
        .get()?.count,
    ).toBe(0);
    handle.close();
  }),
);

it.effect('never retries a locked or ambiguous target and recovers on a later inbound bubble', () =>
  Effect.gen(function* likeFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-like-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    seedInbound(handle.database, 'locked-message', 1, 'first');
    seedInbound(handle.database, 'next-message', 2, 'second');
    seedInbound(handle.database, 'ambiguous-message', 3, 'same text');
    seedInbound(handle.database, 'permission-message', 4, 'permission');
    seedInbound(handle.database, 'restart-message', 5, 'after restart');
    seedInbound(handle.database, 'recovered-message', 6, 'recovered');
    const calls: string[] = [];
    const failures: unknown[] = [];
    const acknowledgement = makeLikeAcknowledgement(
      makeLikeJournal(handle.database),
      outcomeRunner(
        [
          { kind: 'skipped', reason: 'locked' },
          { kind: 'liked' },
          { kind: 'skipped', reason: 'target_ambiguous' },
          { kind: 'skipped', reason: 'accessibility_unavailable' },
          { kind: 'skipped', reason: 'messages_unavailable' },
          { kind: 'liked' },
        ],
        calls,
      ),
      {
        report: (error): void => {
          failures.push(error);
        },
      },
    );
    yield* acknowledgement.acknowledge(
      InboundMessageId.make('locked-message'),
      'first',
      new Date(),
    );
    yield* acknowledgement.acknowledge(
      InboundMessageId.make('locked-message'),
      'first',
      new Date(),
    );
    expect((yield* acknowledgement.status).degraded).toBe(true);
    yield* acknowledgement.acknowledge(InboundMessageId.make('next-message'), 'second', new Date());
    expect((yield* acknowledgement.status).available).toBe(true);
    yield* acknowledgement.acknowledge(
      InboundMessageId.make('ambiguous-message'),
      'same text',
      new Date(),
    );
    yield* acknowledgement.acknowledge(
      InboundMessageId.make('permission-message'),
      'permission',
      new Date(),
    );
    expect((yield* acknowledgement.status).lastFailureReason).toBe('accessibility_unavailable');
    yield* acknowledgement.acknowledge(
      InboundMessageId.make('restart-message'),
      'after restart',
      new Date(),
    );
    yield* acknowledgement.acknowledge(
      InboundMessageId.make('recovered-message'),
      'recovered',
      new Date(),
    );
    expect((yield* acknowledgement.status).available).toBe(true);
    expect(calls).toEqual([
      'first',
      'second',
      'same text',
      'permission',
      'after restart',
      'recovered',
    ]);
    expect(failures).toEqual([]);
    expect(
      handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM like_attempts')
        .get()?.count,
    ).toBe(6);
    handle.close();
  }),
);
