import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Fiber, Result } from 'effect';
import { afterEach, expect } from 'vitest';

import { openJournal } from '../src/database';
import { MessagesDeliveryError } from '../src/delivery/error';
import { makeDeliveryJournal } from '../src/delivery/journal';
import { textsMatch, type MessagesTransport } from '../src/delivery/messages-transport';
import type { DeliveryJournal, PreparedTurnNotice, TurnNoticeKind } from '../src/delivery/model';
import { makeDeliveryService, type DeliveryService } from '../src/delivery/service';
import { GenerationId, InboundMessageId, LogicalTurnId } from '../src/domain/ids';
import { makeSchedulerJournal } from '../src/journal/scheduler-journal';
import type { TurnIdentity } from '../src/scheduler/model';

const roots: string[] = [];
const turnIdentity = {
  generationId: GenerationId.make('generation'),
  logicalTurnId: LogicalTurnId.make('turn'),
} satisfies TurnIdentity;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
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
  database.run(
    `INSERT INTO scheduler_state(
       singleton, generation_id, active_logical_turn_id, active_codex_turn_id,
       active_acknowledged, generation_broken, timer_deadline_at, updated_at
     ) VALUES (1, 'generation', 'turn', NULL, 0, 0, NULL, ?)`,
    [now],
  );
};

const resetTurn = (database: Database): Effect.Effect<void, unknown> => {
  const resetAt = new Date('2026-07-14T12:01:00.000Z');
  const nextGenerationId = GenerationId.make('generation-2');
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (
       'reset-command', 'reset-message', 99, 'any;-;+15555550199', '+15555550199',
       'iMessage', '/new', ?, ?
     )`,
    [resetAt.toISOString(), resetAt.toISOString()],
  );
  return makeSchedulerJournal(database).commitTransition(
    {
      actions: [
        {
          commandMessageId: InboundMessageId.make('reset-command'),
          kind: 'ResetGeneration',
          newGenerationId: nextGenerationId,
          oldGenerationId: turnIdentity.generationId,
        },
      ],
      state: {
        active: null,
        codexThreadId: null,
        configurationCurrent: true,
        generationBroken: false,
        generationId: nextGenerationId,
        pool: [],
      },
    },
    resetAt,
  );
};

const prepareTurnNotice = (
  journal: Pick<DeliveryJournal, 'prepareTurnNotice'>,
  sourceId: string,
  kind: TurnNoticeKind,
  text: string,
  createdAt = new Date(),
): Effect.Effect<PreparedTurnNotice, unknown> =>
  journal
    .prepareTurnNotice(turnIdentity, sourceId, kind, text, createdAt)
    .pipe(
      Effect.flatMap((prepared) =>
        prepared === null
          ? Effect.die(new Error('active turn notice was not prepared'))
          : Effect.succeed(prepared),
      ),
    );

const deliverTurnNotice = (
  service: DeliveryService,
  sourceId: string,
  kind: TurnNoticeKind,
  text: string,
  createdAt = new Date(),
): Effect.Effect<void, unknown> =>
  prepareTurnNotice(service, sourceId, kind, text, createdAt).pipe(
    Effect.flatMap(service.deliverPreparedTurnNotice),
  );

const transport = (
  send: MessagesTransport['send'],
  findMatchingAfter: MessagesTransport['findMatchingAfter'],
): MessagesTransport => ({
  close: (): void => {
    // Test transport owns no resources.
  },
  findMatchingAfter,
  frontier: Effect.succeed(10),
  refresh: Effect.void,
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
    yield* deliverTurnNotice(service, 'ack-item', 'WorkAck', 'Looking into it now', new Date());
    yield* deliverTurnNotice(service, 'ack-item', 'WorkAck', 'Looking into it now', new Date());
    expect(sends).toBe(1);
    expect(
      handle.database.query<{ state: string }, []>('SELECT state FROM outbound_messages').get()
        ?.state,
    ).toBe('Delivered');
    const longFinal = yield* prepareTurnNotice(
      journal,
      'long-final',
      'Final',
      'x'.repeat(10_001),
      new Date(),
    );
    expect(longFinal.chunks).toHaveLength(2);
    expect(longFinal.chunks.every(({ text }) => text.length <= 10_000)).toBe(true);
    const blank = yield* Effect.result(
      prepareTurnNotice(journal, 'blank-final', 'Final', '   ', new Date()),
    );
    expect(Result.isFailure(blank)).toBe(true);
    if (Result.isFailure(blank)) {
      expect(blank.failure).toMatchObject({
        _tag: 'JournalTransactionError',
        message: 'prepare turn notice failed',
        transaction: 'prepareTurnNotice',
      });
      expect(blank.failure).toHaveProperty('cause');
    }
    handle.close();
  }),
);

it.effect('/new supersession after prepare prevents a delayed turn-notice send', () =>
  Effect.gen(function* preparedBeforeReset() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-delivery-superseded-'));
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
        () => Effect.succeed(null),
      ),
    );
    const prepared = yield* prepareTurnNotice(
      service,
      'delayed-final',
      'Final',
      'Do not cross the reset.',
    );
    const release = Promise.withResolvers<undefined>();
    const delivery = yield* Effect.promise(() => release.promise).pipe(
      Effect.andThen(service.deliverPreparedTurnNotice(prepared)),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;

    yield* resetTurn(handle.database);
    release.resolve();
    yield* Fiber.join(delivery);

    expect(sends).toBe(0);
    expect(
      handle.database.query<{ state: string }, []>('SELECT state FROM outbound_messages').get()
        ?.state,
    ).toBe('Superseded');
    expect(
      handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM delivery_attempts')
        .get()?.count,
    ).toBe(0);
    handle.close();
  }),
);

it.effect('receipt reconciliation cannot revive a superseded turn notice', () =>
  Effect.gen(function* supersededReceipt() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-delivery-superseded-receipt-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    seedTurn(handle.database);
    const journal = makeDeliveryJournal(handle.database);
    const prepared = yield* prepareTurnNotice(
      journal,
      'claimed-final',
      'Final',
      'Claimed before reset.',
    );
    const [chunk] = prepared.chunks;
    if (chunk === undefined) {
      throw new Error('expected prepared turn-notice chunk');
    }
    const attemptId = yield* journal.claimTurnAttempt(turnIdentity, chunk.id, 20, new Date());
    if (attemptId === null) {
      throw new Error('expected active turn-notice claim');
    }

    yield* resetTurn(handle.database);
    yield* journal.markReconciled(attemptId, chunk.id, 21, 'late-receipt', new Date());

    expect(
      handle.database
        .query<{ delivered_at: null | string; state: string }, []>(
          'SELECT state, delivered_at FROM outbound_messages',
        )
        .get(),
    ).toStrictEqual({ delivered_at: null, state: 'Superseded' });
    expect(
      handle.database.query<{ state: string }, []>('SELECT state FROM delivery_attempts').get()
        ?.state,
    ).toBe('Reconciled');
    handle.close();
  }),
);

it.effect('keys a failure notice by logical turn across legacy physical source identities', () =>
  Effect.gen(function* distinctFailureDelivery() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-delivery-failure-role-'));
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
        (_frontier, text) =>
          Effect.succeed({ guid: `guid-${String(sends)}-${text}`, rowId: 20 + sends }),
      ),
    );
    const logicalTurnId = LogicalTurnId.make('turn');

    yield* service.deliverFailureNotice(
      logicalTurnId,
      'Spike hit an error: interrupted',
      new Date(),
    );
    handle.database.run(
      "UPDATE outbound_messages SET source_id = 'turn-1' WHERE source_kind = 'TurnFailureNotice'",
    );
    yield* service.deliverFailureNotice(
      logicalTurnId,
      'Spike hit an error: interrupted',
      new Date(),
    );
    yield* deliverTurnNotice(service, 'turn-1', 'Final', 'Recovered answer.', new Date());
    yield* deliverTurnNotice(service, 'turn-1', 'Final', 'Recovered answer.', new Date());

    expect(sends).toBe(2);
    expect(
      handle.database
        .query<{ message_kind: string; source_id: string; source_kind: string; state: string }, []>(
          `SELECT source_kind, source_id, message_kind, state FROM outbound_messages
           ORDER BY source_kind`,
        )
        .all(),
    ).toStrictEqual([
      {
        message_kind: 'Final',
        source_id: 'turn-1',
        source_kind: 'CodexAgentItem',
        state: 'Delivered',
      },
      {
        message_kind: 'Final',
        source_id: 'turn-1',
        source_kind: 'TurnFailureNotice',
        state: 'Delivered',
      },
    ]);
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
    yield* deliverTurnNotice(service, 'final-item', 'Final', 'Done.', new Date());
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
    const prepared = yield* prepareTurnNotice(
      journal,
      'restart-item',
      'Final',
      'Recovered.',
      new Date(),
    );
    const [chunk] = prepared.chunks;
    if (chunk === undefined) {
      throw new Error('expected prepared chunk');
    }
    const attemptId = yield* journal.claimAttempt(chunk.id, 20, new Date());
    if (attemptId === null) {
      throw new Error('restart delivery attempt was not claimed');
    }
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
    const prepared = yield* prepareTurnNotice(
      journal,
      'sent-item',
      'Final',
      'Sent once.',
      new Date(),
    );
    const [chunk] = prepared.chunks;
    if (chunk === undefined) {
      throw new Error('expected prepared chunk');
    }
    const attemptId = yield* journal.claimAttempt(chunk.id, 20, new Date());
    if (attemptId === null) {
      throw new Error('sent delivery attempt was not claimed');
    }
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
    const prepared = yield* prepareTurnNotice(
      journal,
      'exhausted-item',
      'Final',
      'Do not send this again.',
      new Date(),
    );
    const [chunk] = prepared.chunks;
    if (chunk === undefined) {
      throw new Error('expected prepared chunk');
    }
    const attemptId = yield* journal.claimAttempt(chunk.id, 20, new Date());
    if (attemptId === null) {
      throw new Error('exhausted delivery attempt was not claimed');
    }
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
      deliverTurnNotice(
        service,
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
