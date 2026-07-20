import type { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import type { CodexServerRequest } from '../src/codex/server-request-registry';
import type { ObservedMessage } from '../src/domain/inbound';
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

const attachmentInbound = (rowId: number, text: null | string = null): ObservedMessage => ({
  ...inbound(rowId, ''),
  attachments: [
    {
      attachmentGuid: `attachment-${String(rowId)}`,
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      totalBytes: 4,
      transferName: null,
      uti: 'public.jpeg',
    },
  ],
  text,
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

it.effect('resolves approval and capacity rotation while attachment staging is blocked', () =>
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
    fixture.push(attachmentInbound(2));
    const attachmentSourceRoot = path.join(path.dirname(fixture.database.filename), 'Attachments');
    chmodSync(attachmentSourceRoot, 0o000);
    now = new Date('2026-07-14T12:02:00.000Z');
    yield* fixture.engine.pollOnce;
    const whilePending = yield* Effect.race(
      fixture.engine.accountUnavailable.pipe(Effect.as('rotated')),
      Effect.promise(() => Bun.sleep(20)).pipe(Effect.as('blocked')),
    );
    expect(whilePending).toBe('blocked');
    expect(
      fixture.database
        .query<{ state: string }, []>(
          "SELECT state FROM outage_episodes WHERE kind = 'AttachmentStagingPermissionDenied'",
        )
        .get(),
    ).toStrictEqual({ state: 'Open' });

    fixture.push({ ...inbound(3, '/yes'), sentAt: now });
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

    chmodSync(attachmentSourceRoot, 0o700);
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('dispatches trusted controls while attachment staging remains blocked', () =>
  Effect.gen(function* trustedControlsDuringAttachmentOutage() {
    const fixture = yield* makeEngineFixture();
    const attachmentSourceRoot = path.join(path.dirname(fixture.database.filename), 'Attachments');
    fixture.push(attachmentInbound(1));
    chmodSync(attachmentSourceRoot, 0o000);

    yield* fixture.engine.pollOnce;
    expect(
      fixture.database
        .query<{ state: string }, []>(
          "SELECT state FROM outage_episodes WHERE kind = 'AttachmentStagingPermissionDenied'",
        )
        .get(),
    ).toStrictEqual({ state: 'Open' });

    fixture.push(
      inbound(2, 'ordinary work must wait'),
      inbound(3, ' /STATUS '),
      inbound(4, '/new'),
    );
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));

    expect(fixture.sent).toStrictEqual(['Spike ok · uptime 1m', 'New chat started']);
    expect(fixture.likes).toStrictEqual([' /STATUS ', '/new']);
    expect(fixture.turnsStarted).toStrictEqual([]);
    expect(fixture.inputs).toStrictEqual([]);
    expect(
      fixture.database
        .query<{ command: string }, []>(
          'SELECT command FROM handled_control_messages ORDER BY rowid',
        )
        .all(),
    ).toStrictEqual([{ command: '/status' }, { command: '/new' }]);
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM input_batch_messages')
        .get(),
    ).toStrictEqual({ count: 0 });

    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    expect(fixture.sent).toStrictEqual(['Spike ok · uptime 1m', 'New chat started']);
    expect(fixture.likes).toStrictEqual([' /STATUS ', '/new']);

    chmodSync(attachmentSourceRoot, 0o700);
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('does not let an attachment-bearing control block ready ordinary work', () =>
  Effect.gen(function* attachmentControlDoesNotSetFrontier() {
    const turn = Promise.withResolvers<null>();
    const fixture = yield* makeEngineFixture({
      behavior: { finalAnswer: 'ordinary complete', gate: turn.promise },
    });
    const attachmentSourceRoot = path.join(path.dirname(fixture.database.filename), 'Attachments');
    fixture.push(attachmentInbound(1, ' /STATUS '), inbound(2, 'ready ordinary work'));
    chmodSync(attachmentSourceRoot, 0o000);

    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));

    expect(fixture.sent).toStrictEqual(['Spike ok · uptime 1m']);
    expect(fixture.inputs).toStrictEqual(['ready ordinary work']);
    expect(fixture.turnsStarted).toStrictEqual(['turn-1']);
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM input_batch_messages')
        .get(),
    ).toStrictEqual({ count: 1 });
    expect(
      fixture.database
        .query<{ state: string }, []>(
          "SELECT state FROM outage_episodes WHERE kind = 'AttachmentStagingPermissionDenied'",
        )
        .get(),
    ).toStrictEqual({ state: 'Open' });

    turn.resolve(null);
    yield* Effect.promise(() => Bun.sleep(0));
    yield* fixture.engine.drain;
    chmodSync(attachmentSourceRoot, 0o700);
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('dispatches a ready prefix and later control once across an attachment frontier', () =>
  Effect.gen(function* mixedAttachmentFrontier() {
    const turn = Promise.withResolvers<null>();
    const fixture = yield* makeEngineFixture({
      behavior: { finalAnswer: 'prefix complete', gate: turn.promise },
    });
    const attachmentSourceRoot = path.join(path.dirname(fixture.database.filename), 'Attachments');
    fixture.push(
      inbound(1, 'ready prefix'),
      attachmentInbound(2),
      inbound(3, 'later ordinary work'),
      inbound(4, '/status'),
    );
    chmodSync(attachmentSourceRoot, 0o000);

    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));

    expect(fixture.sent).toStrictEqual(['Spike ok · uptime 1m']);
    expect(fixture.inputs).toStrictEqual(['ready prefix']);
    expect(fixture.turnsStarted).toStrictEqual(['turn-1']);
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM input_batch_messages')
        .get(),
    ).toStrictEqual({ count: 1 });

    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    expect(fixture.sent).toStrictEqual(['Spike ok · uptime 1m']);
    expect(fixture.inputs).toStrictEqual(['ready prefix']);
    expect(fixture.turnsStarted).toStrictEqual(['turn-1']);

    turn.resolve(null);
    yield* Effect.promise(() => Bun.sleep(0));
    yield* fixture.engine.drain;
    chmodSync(attachmentSourceRoot, 0o700);
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);
