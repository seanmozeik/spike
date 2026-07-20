import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect, vi } from 'vitest';

import { openJournal } from '../src/database';
import { MessagesDeliveryError } from '../src/delivery/error';
import { makeDeliveryJournal } from '../src/delivery/journal';
import type { MessagesTransport } from '../src/delivery/messages-transport';
import { makeDeliveryService } from '../src/delivery/service';
import { makeOutageJournal } from '../src/outage/journal';
import { makeOutageService, type OutageDelivery } from '../src/outage/service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const fixture = (): ReturnType<typeof openJournal> => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-outage-service-'));
  roots.push(root);
  return openJournal(path.join(root, 'spike.db'));
};

const concurrentFrontier = (): Effect.Effect<number> => {
  let callers = 0;
  const release = Promise.withResolvers<undefined>();
  return Effect.promise(async () => {
    callers += 1;
    if (callers === 2) {
      release.resolve();
    }
    await release.promise;
    return 0;
  });
};

it.effect('delivers one safe authentication notice across repeated reports', () =>
  Effect.gen(function* deduplicatedNoticeFixture() {
    const handle = yield* fixture();
    let sent = false;
    const texts: string[] = [];
    const transport: MessagesTransport = {
      close: (): void => undefined,
      findMatchingAfter: () => Effect.succeed(sent ? { guid: 'outage-message', rowId: 1 } : null),
      frontier: Effect.succeed(0),
      refresh: Effect.void,
      send: (text) =>
        Effect.sync(() => {
          sent = true;
          texts.push(text);
        }),
    };
    const deliveryService = makeDeliveryService(makeDeliveryJournal(handle.database), transport);
    const delivery: OutageDelivery = {
      deliver: (episodeId, text, at) => deliveryService.deliverOutageNotice(episodeId, text, at),
    };
    const service = makeOutageService(makeOutageJournal(handle.database), delivery);

    yield* service.authenticationUnavailable(new Date('2026-07-19T12:00:00.000Z'));
    yield* service.authenticationUnavailable(new Date('2026-07-19T12:01:00.000Z'));

    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('spike accounts list');
    expect(texts[0]).not.toMatch(/token|secret|auth\.json/iu);
    expect(
      handle.database
        .query<{ state: string }, []>(
          "SELECT state FROM outbound_messages WHERE message_kind = 'OutageNotice'",
        )
        .get()?.state,
    ).toBe('Delivered');
    handle.close();
  }),
);

it.effect('claims one sender for concurrent reports of the same outage', () =>
  Effect.gen(function* concurrentOutageFixture() {
    const handle = yield* fixture();
    let sends = 0;
    const transport: MessagesTransport = {
      close: (): void => undefined,
      findMatchingAfter: () =>
        Effect.succeed(sends === 0 ? null : { guid: 'concurrent-outage', rowId: 1 }),
      frontier: concurrentFrontier(),
      refresh: Effect.void,
      send: () =>
        Effect.sync(() => {
          sends += 1;
        }),
    };
    const deliveryService = makeDeliveryService(makeDeliveryJournal(handle.database), transport);
    const service = makeOutageService(makeOutageJournal(handle.database), {
      deliver: (episodeId, text, at) => deliveryService.deliverOutageNotice(episodeId, text, at),
    });
    const at = new Date('2026-07-19T12:00:00.000Z');

    yield* Effect.all(
      [service.authenticationUnavailable(at), service.authenticationUnavailable(at)],
      { concurrency: 'unbounded' },
    );

    expect(sends).toBe(1);
    expect(
      handle.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM failures').get()
        ?.count,
    ).toBe(1);
    expect(
      handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM delivery_attempts')
        .get()?.count,
    ).toBe(1);
    handle.close();
  }),
);

it.effect('retries a real pre-send failure after recovery without duplicating journal rows', () =>
  Effect.gen(function* retryNoticeFixture() {
    const handle = yield* fixture();
    const transportError = new MessagesDeliveryError({
      cause: new Error('transport unavailable'),
      message: 'transport unavailable',
      operation: 'open',
    });
    const unavailableTransport: MessagesTransport = {
      close: (): void => undefined,
      findMatchingAfter: () => Effect.succeed(null),
      frontier: Effect.fail(transportError),
      refresh: Effect.void,
      send: () => Effect.die('send must not run without a frontier'),
    };
    const unavailableService = makeDeliveryService(
      makeDeliveryJournal(handle.database),
      unavailableTransport,
    );
    const unavailableDelivery: OutageDelivery = {
      deliver: (episodeId, text, at) => unavailableService.deliverOutageNotice(episodeId, text, at),
    };
    const interrupted = makeOutageService(makeOutageJournal(handle.database), unavailableDelivery);

    yield* interrupted.authenticationUnavailable(new Date('2026-07-19T12:00:00.000Z'));
    expect(
      handle.database
        .query<{ state: string }, []>(
          "SELECT state FROM outbound_messages WHERE message_kind = 'OutageNotice'",
        )
        .get()?.state,
    ).toBe('Prepared');
    expect(yield* interrupted.recovered(new Date('2026-07-19T12:00:30.000Z'))).toBe(1);

    let sent = false;
    const texts: string[] = [];
    const transport: MessagesTransport = {
      close: (): void => undefined,
      findMatchingAfter: () => Effect.succeed(sent ? { guid: 'recovered-outage', rowId: 1 } : null),
      frontier: Effect.succeed(0),
      refresh: Effect.void,
      send: (text) =>
        Effect.sync(() => {
          sent = true;
          texts.push(text);
        }),
    };
    const recoveredDelivery = makeDeliveryService(makeDeliveryJournal(handle.database), transport);
    yield* recoveredDelivery.recover;

    expect(texts).toHaveLength(1);
    expect(
      handle.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM outbound_messages WHERE message_kind = 'OutageNotice'",
        )
        .get()?.count,
    ).toBe(1);
    handle.close();
  }),
);

it.effect('persists runtime death without blocking shutdown on inline delivery', () =>
  Effect.gen(function* runtimeDeathFixture() {
    const handle = yield* fixture();
    const deliver = vi.fn(() => Effect.never);
    const service = makeOutageService(makeOutageJournal(handle.database), { deliver });

    yield* service.runtimeUnavailable(new Date('2026-07-19T12:00:00.000Z'));

    expect(deliver).not.toHaveBeenCalled();
    expect(
      handle.database
        .query<{ kind: string; state: string }, []>(
          "SELECT kind, state FROM outage_episodes WHERE kind = 'CodexRuntime'",
        )
        .get(),
    ).toEqual({ kind: 'CodexRuntime', state: 'Open' });
    expect(
      handle.database
        .query<{ message_kind: string; state: string }, []>(
          'SELECT message_kind, state FROM outbound_messages WHERE outage_episode_id IS NOT NULL',
        )
        .get(),
    ).toEqual({ message_kind: 'OutageNotice', state: 'Prepared' });
    handle.close();
  }),
);

it.effect('includes the earliest capacity retry boundary and closes on recovery', () =>
  Effect.gen(function* capacityNoticeFixture() {
    const handle = yield* fixture();
    const texts: string[] = [];
    const delivery: OutageDelivery = {
      deliver: (_episodeId, text) =>
        Effect.sync(() => {
          texts.push(text);
        }),
    };
    const service = makeOutageService(makeOutageJournal(handle.database), delivery);
    const retryAt = new Date('2026-07-19T17:00:00.000Z');

    yield* service.capacityUnavailable(retryAt, new Date('2026-07-19T12:00:00.000Z'));
    expect(texts).toStrictEqual([
      'Every configured Codex account reached capacity. The earliest known retry boundary is 2026-07-19T17:00:00.000Z.',
    ]);
    expect(yield* service.recovered(new Date('2026-07-19T12:30:00.000Z'))).toBe(1);
    expect(yield* makeOutageJournal(handle.database).listOpen).toStrictEqual([]);
    handle.close();
  }),
);
