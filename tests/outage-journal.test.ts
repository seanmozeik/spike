import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { afterEach, expect } from 'vitest';

import { openJournal } from '../src/database';
import { makeOutageJournal } from '../src/outage/journal';

const roots: string[] = [];

const fixture = (): ReturnType<typeof openJournal> => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-outage-journal-'));
  roots.push(root);
  return openJournal(path.join(root, 'spike.db'));
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('opens one durable episode and one deduplicated notice per outage', () =>
  Effect.gen(function* openOutageFixture() {
    const handle = yield* fixture();
    const journal = makeOutageJournal(handle.database);
    const at = new Date('2026-07-19T12:00:00.000Z');
    const [first, repeated] = yield* Effect.all(
      [
        journal.open('CodexAuthentication', 'Repair the account.', at),
        journal.open('CodexAuthentication', 'Do not duplicate this notice.', at),
      ],
      { concurrency: 'unbounded' },
    );

    expect(first.id).toBe(repeated.id);
    expect([first.opened, repeated.opened]).toContain(true);
    expect([first.opened, repeated.opened]).toContain(false);
    expect(yield* journal.listOpen).toMatchObject([
      { id: first.id, kind: 'CodexAuthentication', openedAt: at },
    ]);
    expect(
      handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM outage_episodes')
        .get()?.count,
    ).toBe(1);
    expect(
      handle.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM outbound_messages WHERE message_kind = 'OutageNotice'",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      handle.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM failures').get()
        ?.count,
    ).toBe(1);
    handle.close();
  }),
);

it.effect('rolls back the episode when its durable notice cannot be prepared', () =>
  Effect.gen(function* atomicOpenFixture() {
    const handle = yield* fixture();
    const journal = makeOutageJournal(handle.database);
    const result = yield* Effect.result(
      journal.open('CodexRuntime', '   ', new Date('2026-07-19T12:00:00.000Z')),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: 'JournalTransactionError',
        message: 'outage journal transaction failed: openOutage',
        transaction: 'openOutage',
      });
      expect(result.failure).toHaveProperty('cause');
    }
    expect(
      handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM outage_episodes')
        .get()?.count,
    ).toBe(0);
    expect(
      handle.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM failures').get()
        ?.count,
    ).toBe(0);
    handle.close();
  }),
);

it.effect('resolves an outage transactionally and permits a later episode', () =>
  Effect.gen(function* resolveOutageFixture() {
    const handle = yield* fixture();
    const journal = makeOutageJournal(handle.database);
    const first = yield* journal.open(
      'CodexCapacity',
      'Capacity is exhausted.',
      new Date('2026-07-19T12:00:00.000Z'),
    );
    expect(yield* journal.resolve(new Date('2026-07-19T12:05:00.000Z'))).toBe(1);
    expect(yield* journal.listOpen).toStrictEqual([]);
    expect(
      handle.database
        .query<{ state: string }, [string]>(
          'SELECT state FROM outbound_messages WHERE outage_episode_id = ?',
        )
        .get(first.id)?.state,
    ).toBe('Prepared');

    const second = yield* journal.open(
      'CodexCapacity',
      'Capacity is exhausted again.',
      new Date('2026-07-19T13:00:00.000Z'),
    );
    expect(second.id).not.toBe(first.id);
    expect(
      handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM outage_episodes')
        .get()?.count,
    ).toBe(2);
    handle.close();
  }),
);
