import type { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import type { CodexServerRequest } from '../src/codex/server-request-registry';
import { WaitingForAuthentication, WaitingForCapacity } from '../src/errors';
import { inbound, makeEngineFixture } from './engine-fixture';

interface ObservationRow {
  readonly mode: string;
  readonly reset_at: string | null;
  readonly usage_json: string | null;
}

const RESET_AT = new Date('2026-07-14T17:00:00.000Z');
const ENGINE_EPOCH = new Date(0);
const EXHAUSTED_RATE_LIMITS = {
  rateLimits: {
    primary: { resetsAt: RESET_AT.getTime() / 1000, usedPercent: 100, windowDurationMins: 300 },
  },
};

const commandRequest = (): CodexServerRequest => ({
  id: 1,
  method: 'item/commandExecution/requestApproval',
  params: {
    availableDecisions: ['accept', 'decline'],
    command: 'network-command',
    cwd: '/workspace',
    itemId: 'item-1',
    reason: 'needs network',
    startedAtMs: Date.parse('2026-07-14T12:00:00.000Z'),
    threadId: 'thread-1',
    turnId: 'turn-1',
  },
});

const attemptState = (database: Database): string | null =>
  database
    .query<{ state: string }, []>('SELECT state FROM codex_attempts ORDER BY rowid DESC LIMIT 1')
    .get()?.state ?? null;

const latestObservation = (database: Database): ObservationRow | null =>
  database
    .query<ObservationRow, []>(
      'SELECT mode, reset_at, usage_json FROM account_observations ORDER BY id DESC LIMIT 1',
    )
    .get();

it.effect('preserves the Prepared attempt when capacity fails before Codex accepts the turn', () =>
  Effect.gen(function* preservePreparedAttempt() {
    const fixture = yield* makeEngineFixture({
      behavior: {
        rateLimits: EXHAUSTED_RATE_LIMITS,
        startFailure: '429 rate limit exhausted',
        usageFailure: 'usage unavailable',
      },
      now: () => ENGINE_EPOCH,
    });
    fixture.push(inbound(1, 'keep this turn durable'));

    yield* fixture.engine.pollOnce;
    const failure = yield* Effect.race(
      fixture.engine.accountUnavailable,
      Effect.promise(() => Bun.sleep(200)).pipe(Effect.as(null)),
    );
    expect(failure).not.toBeNull();
    if (failure === null) {
      throw new Error('account failover signal did not resolve');
    }
    expect(failure).toBeInstanceOf(WaitingForCapacity);
    expect(attemptState(fixture.database)).toBe('Prepared');
    expect(yield* fixture.engine.snapshot).toMatchObject({ active: { codexTurnId: null } });
    expect(
      fixture.database
        .query<{ state: string }, []>('SELECT state FROM logical_turns ORDER BY rowid DESC LIMIT 1')
        .get()?.state,
    ).not.toBe('Failed');
    expect(latestObservation(fixture.database)).toEqual({
      mode: 'Capacity',
      reset_at: RESET_AT.toISOString(),
      usage_json: null,
    });

    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('keeps authentication classification when optional account usage fails', () =>
  Effect.gen(function* authenticationFailureFixture() {
    const fixture = yield* makeEngineFixture({
      behavior: {
        rateLimitsFailure: 'rate limits unavailable',
        startFailure: '401 authentication required',
        usageFailure: 'usage unavailable',
      },
    });
    fixture.push(inbound(1, 'authenticate this turn'));

    yield* fixture.engine.pollOnce;
    const failure = yield* Effect.race(
      fixture.engine.accountUnavailable,
      Effect.promise(() => Bun.sleep(200)).pipe(Effect.as(null)),
    );
    expect(failure).toBeInstanceOf(WaitingForAuthentication);
    expect(latestObservation(fixture.database)).toEqual({
      mode: 'Authentication',
      reset_at: null,
      usage_json: null,
    });

    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('rotates on exhausted rate limits when optional account usage fails', () =>
  Effect.gen(function* optionalUsageFailureFixture() {
    const fixture = yield* makeEngineFixture({
      behavior: { rateLimits: EXHAUSTED_RATE_LIMITS, usageFailure: 'usage unavailable' },
    });

    yield* fixture.engine.pollOnce;
    const failure = yield* Effect.race(
      fixture.engine.accountUnavailable,
      Effect.promise(() => Bun.sleep(200)).pipe(Effect.as(null)),
    );
    expect(failure).toBeInstanceOf(WaitingForCapacity);
    expect(latestObservation(fixture.database)).toEqual({
      mode: 'Capacity',
      reset_at: RESET_AT.toISOString(),
      usage_json: null,
    });

    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('defers capacity rotation until the active turn and pending approval are resolved', () =>
  Effect.gen(function* pendingApprovalBoundary() {
    let now = new Date('2026-07-14T12:00:00.000Z');
    let limits: unknown = {};
    const turn = Promise.withResolvers<null>();
    const fixture = yield* makeEngineFixture({
      behavior: { gate: turn.promise, rateLimits: () => limits },
      now: () => now,
    });
    fixture.push(inbound(1, 'start a guarded turn'));

    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    fixture.requestApproval(commandRequest());
    yield* fixture.engine.pollOnce;
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM approval_requests').get()
        ?.state,
    ).toBe('Pending');

    limits = {
      rateLimits: {
        primary: {
          resetsAt: Date.parse('2026-07-14T17:00:00.000Z') / 1000,
          usedPercent: 100,
          windowDurationMins: 300,
        },
      },
    };
    now = new Date('2026-07-14T12:02:00.000Z');
    yield* fixture.engine.pollOnce;
    const whilePending = yield* Effect.race(
      fixture.engine.accountUnavailable.pipe(Effect.as('rotated')),
      Effect.promise(() => Bun.sleep(20)).pipe(Effect.as('blocked')),
    );
    expect(whilePending).toBe('blocked');

    fixture.push({ ...inbound(2, '/yes'), sentAt: now });
    yield* fixture.engine.pollOnce;
    expect(fixture.responses).toEqual([{ id: 1, result: { decision: 'accept' } }]);
    turn.resolve(null);
    yield* Effect.promise(() => Bun.sleep(0));
    yield* fixture.engine.drain;
    now = new Date('2026-07-14T12:03:00.000Z');
    yield* fixture.engine.pollOnce;
    const requested = yield* Effect.race(
      fixture.engine.accountUnavailable,
      Effect.promise(() => Bun.sleep(200)).pipe(Effect.as(null)),
    );
    expect(requested).toBeInstanceOf(WaitingForCapacity);

    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);
