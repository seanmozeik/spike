import type { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, vi } from 'vitest';

import type { CodexServerRequest } from '../src/codex/server-request-registry';
import { CHAT_GUID, inbound, makeEngineFixture, type EngineFixture } from './engine-fixture';
import { makeWatcherHarness } from './messages-watcher-harness';

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

const commandRequest = (id: number): CodexServerRequest => ({
  id,
  method: 'item/commandExecution/requestApproval',
  params: {
    availableDecisions: ['accept', 'decline'],
    command: 'curl https://example.com',
    cwd: '/workspace',
    itemId: `item-${String(id)}`,
    reason: 'needs network',
    startedAtMs: Date.now(),
    threadId: 'thread-1',
    turnId: 'turn-1',
  },
});

const approvalState = (database: Database, rpcId: number): string | null =>
  database
    .query<{ state: string }, [string]>(
      'SELECT state FROM approval_requests WHERE rpc_request_id_json = ?',
    )
    .get(JSON.stringify(rpcId))?.state ?? null;

it.effect('debounces a Messages event burst into one serialized ingestion pass', () =>
  Effect.gen(function* debouncedIngestion() {
    const watcher = makeWatcherHarness();
    const fixture = yield* makeEngineFixture({
      messagesDebounceMs: 5,
      reconcileIntervalMs: 60_000,
      watchMessages: watcher.open,
    });
    const run = yield* Effect.forkChild(fixture.engine.run);
    yield* waitFor(() => {
      expect(fixture.inboxScans).toBeGreaterThan(0);
    });
    yield* Effect.promise(() => Bun.sleep(20));
    const baseline = fixture.inboxScans;

    fixture.push(inbound(1, 'event-driven request'));
    watcher.dirty();
    watcher.dirty();
    watcher.dirty();
    yield* waitFor(() => {
      expect(fixture.inputs).toContain('event-driven request');
    });
    yield* Effect.promise(() => Bun.sleep(20));
    expect(fixture.inboxScans).toBe(baseline + 1);

    watcher.fail();
    expect(
      fixture.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM failures').get(),
    ).toStrictEqual({ count: 1 });
    const diagnostics = fixture.engine.readEventLoopDiagnostics();
    expect(diagnostics.filesystem).toMatchObject({ events: 3, wakes: 1 });
    expect(diagnostics.messages.queries).toBe(fixture.inboxScans);
    expect(diagnostics.messages.passes).toBeGreaterThanOrEqual(diagnostics.messages.queries);
    expect(diagnostics.watcher).toMatchObject({ active: true, failures: 1 });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('/fixture/chat.db');
    expect(serialized).not.toContain('event-driven request');
    yield* shutdown(fixture, run);
  }),
);

it.effect('cancels a pending watcher debounce and ignores callbacks after shutdown', () =>
  Effect.gen(function* cancelWatcherDebounce() {
    const watcher = makeWatcherHarness();
    const fixture = yield* makeEngineFixture({
      messagesDebounceMs: 50,
      reconcileIntervalMs: 60_000,
      watchMessages: watcher.open,
    });
    const run = yield* Effect.forkChild(fixture.engine.run);
    yield* waitFor(() => {
      expect(fixture.inboxScans).toBeGreaterThan(0);
    });
    yield* Effect.promise(() => Bun.sleep(20));
    const baseline = fixture.inboxScans;

    watcher.dirty();
    yield* fixture.engine.shutdown;
    watcher.dirty();
    watcher.fail();
    yield* Effect.promise(() => Bun.sleep(70));

    const diagnostics = fixture.engine.readEventLoopDiagnostics();
    expect(diagnostics.filesystem).toMatchObject({ events: 1, wakes: 0 });
    expect(diagnostics.watcher).toMatchObject({ active: false, closed: true, failures: 0 });
    expect(fixture.inboxScans).toBe(baseline);
    yield* Fiber.interrupt(run);
    fixture.remove();
  }),
);

it.effect('queues one follow-up pass when the inbox becomes dirty during a scan', () =>
  Effect.gen(function* dirtyDuringScan() {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const watcher = makeWatcherHarness();
    const fixture = yield* makeEngineFixture({
      messagesDebounceMs: 5,
      onInboxScan: (scan) =>
        scan === 2
          ? Effect.promise(() => {
              entered.resolve();
              return release.promise;
            })
          : Effect.void,
      reconcileIntervalMs: 60_000,
      watchMessages: watcher.open,
    });
    const run = yield* Effect.forkChild(fixture.engine.run);
    yield* waitFor(() => {
      expect(fixture.inboxScans).toBe(1);
    });

    fixture.push(inbound(1, 'first event'));
    watcher.dirty();
    yield* Effect.promise(() => entered.promise);
    fixture.push(inbound(2, 'event during scan'));
    watcher.dirty();
    yield* Effect.promise(() => Bun.sleep(20));
    release.resolve();

    yield* waitFor(() => {
      expect(fixture.inputs).toStrictEqual(['first event', 'event during scan']);
    });
    expect(fixture.inboxScans).toBe(3);
    yield* shutdown(fixture, run);
  }),
);

it.effect('retries a failed inbox scan without another filesystem event', () =>
  Effect.gen(function* retryFailedScan() {
    const fixture = yield* makeEngineFixture({
      inboxScanFailures: 1,
      phaseRetryMs: 10,
      preexisting: [inbound(1, 'retry after scan failure')],
      prepare: (database) =>
        Effect.sync(() => {
          database.run(
            `INSERT INTO inbox_cursor(chat_guid, last_rowid, last_message_guid, updated_at)
             VALUES (?, 0, NULL, ?)`,
            [CHAT_GUID, new Date('2026-07-14T11:59:00.000Z').toISOString()],
          );
        }),
      reconcileIntervalMs: 60_000,
    });
    const run = yield* Effect.forkChild(fixture.engine.run);
    yield* waitFor(() => {
      expect(fixture.inboxScans).toBe(1);
    });
    expect(fixture.inputs).toStrictEqual([]);

    yield* TestClock.adjust('10 millis');
    yield* waitFor(() => {
      expect(fixture.inputs).toContain('retry after scan failure');
    });
    expect(fixture.inboxScans).toBe(2);
    yield* shutdown(fixture, run);
  }),
);

it.effect('reconciles a missed filesystem event on the slower authoritative timer', () =>
  Effect.gen(function* missedEventReconciliation() {
    const fixture = yield* makeEngineFixture({ reconcileIntervalMs: 10 });
    const run = yield* Effect.forkChild(fixture.engine.run);
    yield* waitFor(() => {
      expect(fixture.inboxScans).toBeGreaterThan(0);
    });
    fixture.push(inbound(1, 'missed watcher event'));
    yield* TestClock.adjust('10 millis');
    yield* waitFor(() => {
      expect(fixture.inputs).toContain('missed watcher event');
    });
    expect(fixture.inboxScans).toBeGreaterThan(1);
    yield* shutdown(fixture, run);
  }),
);

it.effect('records reconciliation failures for rootless soak diagnostics', () =>
  Effect.gen(function* reconciliationDiagnostics() {
    const fixture = yield* makeEngineFixture({ phaseRetryMs: 1000, reconcileIntervalMs: 10 });
    const run = yield* Effect.forkChild(fixture.engine.run);
    yield* waitFor(() => {
      expect(fixture.inboxScans).toBeGreaterThan(0);
    });
    fixture.failNextInboxScans();
    yield* TestClock.adjust('10 millis');
    yield* waitFor(() => {
      expect(fixture.engine.readEventLoopDiagnostics().reconciliation.failures).toBe(1);
    });
    expect(fixture.engine.readEventLoopDiagnostics().reconciliation).toMatchObject({
      failures: 1,
      passes: 1,
    });
    yield* shutdown(fixture, run);
  }),
);

it.effect('expires an approval without a Messages event or reconciliation scan', () =>
  Effect.gen(function* independentApprovalExpiry() {
    const watcher = makeWatcherHarness();
    let now = new Date('2026-07-19T12:00:00.000Z');
    const fixture = yield* makeEngineFixture({
      behavior: { approvalExpiryMs: 20 },
      now: () => now,
      reconcileIntervalMs: 60_000,
      watchMessages: watcher.open,
    });
    const run = yield* Effect.forkChild(fixture.engine.run);
    yield* waitFor(() => {
      expect(fixture.inboxScans).toBeGreaterThan(0);
    });
    yield* Effect.promise(() => Bun.sleep(20));
    const baseline = fixture.inboxScans;

    fixture.requestApproval(commandRequest(7));
    yield* waitFor(() => {
      expect(fixture.sent.some((text) => text.startsWith('Permission requested:'))).toBe(true);
    });
    yield* Effect.yieldNow;
    now = new Date(now.getTime() + 20);
    yield* TestClock.adjust('20 millis');
    yield* waitFor(() => {
      expect(approvalState(fixture.database, 7)).toBe('Expired');
    });
    expect(fixture.responses).toStrictEqual([{ id: 7, result: { decision: 'decline' } }]);
    expect(fixture.inboxScans).toBe(baseline);
    yield* shutdown(fixture, run);
  }),
);
