import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { afterEach, expect } from 'vitest';

import { openJournal } from '../src/database';
import { MessagesDeliveryError } from '../src/delivery/error';
import { makeDeliveryJournal } from '../src/delivery/journal';
import { textsMatch, type MessagesTransport } from '../src/delivery/messages-transport';
import { compactError, makeDeliveryService } from '../src/delivery/service';
import { LogicalTurnId } from '../src/domain/ids';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it('redacts credential-like values and collapses multiline errors', () => {
  expect(compactError(new Error('Bearer secret-token\nsk-abcdefghijk failed'))).toBe(
    '[redacted] [redacted] failed',
  );
});

it('reconciles a long outgoing message from a control-prefixed attributed-body fragment', () => {
  expect(textsMatch('\u0001Spike up · app', 'Spike up · app-server up · weekly 87% left')).toBe(
    true,
  );
  expect(
    textsMatch('\u0001Spike up · app-server up �', 'Spike up · app-server up · weekly 87% left'),
  ).toBe(true);
  expect(textsMatch('Spike up', 'Spike up · app-server up')).toBe(false);
});

const seedTurn = (database: Database): void => {
  const now = new Date().toISOString();
  database.run(
    "INSERT INTO generations(id, sequence, state, created_at) VALUES ('generation', 1, 'Current', ?)",
    [now],
  );
  database.run(
    `INSERT INTO logical_turns(
       id, generation_id, sequence, state, correlation_id, created_at
     ) VALUES ('turn', 'generation', 1, 'Running', 'correlation', ?)`,
    [now],
  );
};

const transport = (
  send: MessagesTransport['send'],
  findMatchingAfter: MessagesTransport['findMatchingAfter'],
): MessagesTransport => ({
  close: (): void => {
    // Test transport owns no resources.
  },
  findMatchingAfter,
  frontier: Effect.succeed(10),
  send,
});

it.effect('prepares idempotently and reconciles a confirmed one-bubble acknowledgement', () =>
  Effect.gen(function* confirmedDelivery() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-delivery-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    seedTurn(handle.database);
    const journal = makeDeliveryJournal(handle.database);
    let sends = 0;
    const service = makeDeliveryService(
      journal,
      transport(
        () =>
          Effect.sync(() => {
            sends += 1;
          }),
        () => Effect.succeed({ guid: 'outbound-guid', rowId: 11 }),
      ),
    );
    yield* service.deliverAssistantMessage(
      LogicalTurnId.make('turn'),
      'ack-item',
      'WorkAck',
      'Looking into it now',
      new Date(),
    );
    yield* service.deliverAssistantMessage(
      LogicalTurnId.make('turn'),
      'ack-item',
      'WorkAck',
      'Looking into it now',
      new Date(),
    );
    expect(sends).toBe(1);
    expect(
      handle.database.query<{ state: string }, []>('SELECT state FROM outbound_messages').get()
        ?.state,
    ).toBe('Delivered');
    const longFinal = yield* journal.prepareAssistantMessage(
      LogicalTurnId.make('turn'),
      'long-final',
      'Final',
      'x'.repeat(10_001),
      new Date(),
    );
    expect(longFinal.chunks).toHaveLength(2);
    expect(longFinal.chunks.every(({ text }) => text.length <= 10_000)).toBe(true);
    const blank = yield* Effect.result(
      journal.prepareAssistantMessage(
        LogicalTurnId.make('turn'),
        'blank-final',
        'Final',
        '   ',
        new Date(),
      ),
    );
    expect(Result.isFailure(blank)).toBe(true);
    handle.close();
  }),
);

it.effect('reconciles an AppleEvent failure before retrying', () =>
  Effect.gen(function* ambiguousDelivery() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-delivery-ambiguous-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    seedTurn(handle.database);
    const journal = makeDeliveryJournal(handle.database);
    let sends = 0;
    const service = makeDeliveryService(
      journal,
      transport(
        () => {
          sends += 1;
          return Effect.fail(
            new MessagesDeliveryError({
              cause: new Error('AppleEvent timeout'),
              message: 'send failed',
              operation: 'send',
            }),
          );
        },
        () => Effect.succeed({ guid: 'delivered-despite-timeout', rowId: 12 }),
      ),
    );
    yield* service.deliverAssistantMessage(
      LogicalTurnId.make('turn'),
      'final-item',
      'Final',
      'Done.',
      new Date(),
    );
    expect(sends).toBe(1);
    expect(
      handle.database.query<{ state: string }, []>('SELECT state FROM delivery_attempts').get()
        ?.state,
    ).toBe('Reconciled');
    handle.close();
  }),
);

it.effect('recovers an unknown attempt after restart without resending a confirmed row', () =>
  Effect.gen(function* restartRecovery() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-delivery-restart-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    seedTurn(handle.database);
    const journal = makeDeliveryJournal(handle.database);
    const prepared = yield* journal.prepareAssistantMessage(
      LogicalTurnId.make('turn'),
      'restart-item',
      'Final',
      'Recovered.',
      new Date(),
    );
    const [chunk] = prepared.chunks;
    if (chunk === undefined) {
      throw new Error('expected prepared chunk');
    }
    const attemptId = yield* journal.beginAttempt(chunk.id, 20, new Date());
    yield* journal.markAttemptUnknown(attemptId, 'process exited', new Date());
    let sends = 0;
    const service = makeDeliveryService(
      journal,
      transport(
        () =>
          Effect.sync(() => {
            sends += 1;
          }),
        () => Effect.succeed({ guid: 'recovered-guid', rowId: 21 }),
      ),
    );
    yield* service.recover;
    expect(sends).toBe(0);
    expect(
      handle.database.query<{ state: string }, []>('SELECT state FROM outbound_messages').get()
        ?.state,
    ).toBe('Delivered');
    handle.close();
  }),
);

it.effect('treats a successful AppleScript send as terminal before confirmation', () =>
  Effect.gen(function* sentIsTerminal() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-delivery-sent-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    seedTurn(handle.database);
    const journal = makeDeliveryJournal(handle.database);
    const prepared = yield* journal.prepareAssistantMessage(
      LogicalTurnId.make('turn'),
      'sent-item',
      'Final',
      'Sent once.',
      new Date(),
    );
    const [chunk] = prepared.chunks;
    if (chunk === undefined) {
      throw new Error('expected prepared chunk');
    }
    const attemptId = yield* journal.beginAttempt(chunk.id, 20, new Date());
    yield* journal.markSent(attemptId, chunk.id, new Date());
    expect(yield* journal.listRecoverable).toHaveLength(0);
    expect(
      handle.database.query<{ state: string }, []>('SELECT state FROM outbound_messages').get()
        ?.state,
    ).toBe('Delivered');
    handle.close();
  }),
);

it.effect('terminates any prior delivery attempt across process restarts without resending', () =>
  Effect.gen(function* exhaustedRestartBudget() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-delivery-exhausted-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    seedTurn(handle.database);
    const journal = makeDeliveryJournal(handle.database);
    const prepared = yield* journal.prepareAssistantMessage(
      LogicalTurnId.make('turn'),
      'exhausted-item',
      'Final',
      'Do not send this again.',
      new Date(),
    );
    const [chunk] = prepared.chunks;
    if (chunk === undefined) {
      throw new Error('expected prepared chunk');
    }
    const attemptId = yield* journal.beginAttempt(chunk.id, 20, new Date());
    yield* journal.markAttemptUnknown(attemptId, 'process exited', new Date());
    let sends = 0;
    const service = makeDeliveryService(
      journal,
      transport(
        () =>
          Effect.sync(() => {
            sends += 1;
          }),
        () => Effect.succeed(null),
      ),
    );
    yield* service.recover;
    expect(sends).toBe(0);
    expect(
      handle.database.query<{ state: string }, []>('SELECT state FROM outbound_messages').get()
        ?.state,
    ).toBe('Failed');
    expect(
      handle.database.query<{ state: string }, []>('SELECT state FROM outbound_chunks').get()
        ?.state,
    ).toBe('Failed');
    handle.close();
  }),
);

it.effect('terminates after one send when confirmation storage is unavailable', () =>
  Effect.gen(function* failedConfirmationRead() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-delivery-read-failure-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    seedTurn(handle.database);
    let sends = 0;
    const service = makeDeliveryService(
      makeDeliveryJournal(handle.database),
      transport(
        () =>
          Effect.sync(() => {
            sends += 1;
          }),
        () =>
          Effect.fail(
            new MessagesDeliveryError({
              cause: new Error('chat.db unavailable'),
              message: 'confirmation read failed',
              operation: 'find',
            }),
          ),
      ),
    );
    const delivery = yield* Effect.result(
      service.deliverAssistantMessage(
        LogicalTurnId.make('turn'),
        'read-failure-item',
        'Final',
        'Do not retry this forever.',
        new Date(),
      ),
    );
    expect(Result.isFailure(delivery)).toBe(true);
    expect(sends).toBe(1);
    expect(
      handle.database.query<{ state: string }, []>('SELECT state FROM outbound_messages').get()
        ?.state,
    ).toBe('Failed');
    handle.close();
  }),
);
