import type { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { makeJournal } from '../src/journal/service';
import { CHAT_GUID, inbound, makeEngineFixture, settle } from './engine-fixture';

const seedActiveTurn = (database: Database): void => {
  const now = '2026-07-14T12:00:00.000Z';
  database.run(
    "INSERT INTO generations VALUES ('generation', 1, 'Current', ?, NULL, 'thread-1', NULL, NULL)",
    [now],
  );
  database.run(
    "INSERT INTO logical_turns VALUES ('logical-turn', 'generation', 1, 'Running', 'correlation', ?, NULL, NULL)",
    [now],
  );
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (
       'inbound-initial', 'message-initial', 1000, 'any;-;+15555550199', '+15555550199',
       'iMessage', 'recovered request', ?, ?
     )`,
    [now, now],
  );
  database.run(
    `INSERT INTO input_batches(id, logical_turn_id, sequence, kind, fingerprint, created_at)
     VALUES ('batch-initial', 'logical-turn', 1, 'Initial', '["inbound-initial"]', ?)`,
    [now],
  );
  database.run(
    `INSERT INTO input_batch_messages(input_batch_id, inbound_message_id, ordinal)
     VALUES ('batch-initial', 'inbound-initial', 0)`,
  );
  database.run(
    `INSERT INTO scheduler_state(
      singleton, generation_id, active_logical_turn_id, active_codex_turn_id,
      active_acknowledged, timer_deadline_at, updated_at
    ) VALUES (1, 'generation', 'logical-turn', 'turn-1', 0, NULL, ?)`,
    [now],
  );
};

const seedAcceptedAttempt = (database: Database): void => {
  database.run(
    `INSERT INTO codex_attempts(
       id, logical_turn_id, input_batch_id, account_id, state, codex_thread_id, codex_turn_id,
       input_fingerprint, frontier_json, submission_kind, started_at
     ) VALUES (
       'attempt-1', 'logical-turn', 'batch-initial', 'test-account', 'Accepted', 'thread-1', 'turn-1',
       'fingerprint', '{"turnIds":[],"itemIds":[]}', 'Start', '2026-07-14T12:00:00.000Z'
     )`,
  );
};

it.effect('runs a quick direct-conversation turn with only one final bubble', () =>
  Effect.gen(function* quickTurn() {
    const fixture = yield* makeEngineFixture({ behavior: { finalAnswer: 'Quick answer.' } });
    fixture.push(inbound(1, 'hello Spike'));
    yield* settle(fixture.engine);
    expect(fixture.sent).toStrictEqual(['Quick answer']);
    expect(fixture.likes).toStrictEqual(['hello Spike']);
    expect(fixture.turnsStarted).toStrictEqual(['turn-1']);
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Completed');
    fixture.remove();
  }),
);

it.effect('/new keeps its pre-bound thread unread until the first turn materializes it', () =>
  Effect.gen(function* newThenFirstTurn() {
    const fixture = yield* makeEngineFixture({ behavior: { finalAnswer: 'First answer.' } });
    fixture.push(inbound(1, '/new'));
    yield* settle(fixture.engine);
    expect(fixture.sent).toStrictEqual(['New chat started']);

    fixture.push(inbound(2, 'hello after reset'));
    yield* settle(fixture.engine);
    expect(fixture.reads).toStrictEqual([]);
    expect(fixture.turnsStarted).toStrictEqual(['turn-1']);
    expect(fixture.sent).toStrictEqual(['New chat started', 'First answer']);
    fixture.remove();
  }),
);

it.effect('turns a status render failure into one terminal control reply', () =>
  Effect.gen(function* failedStatus() {
    const fixture = yield* makeEngineFixture({
      behavior: { statusFailure: 'status snapshot unavailable' },
    });
    fixture.push(inbound(1, '/status'));
    yield* settle(fixture.engine);
    yield* settle(fixture.engine);
    expect(fixture.sent).toStrictEqual(['Spike hit an error: status snapshot unavailable']);
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM handled_control_messages')
        .get()?.count,
    ).toBe(1);
    fixture.remove();
  }),
);

it.effect('delivers one work acknowledgement before forwarding a later turn failure', () =>
  Effect.gen(function* failedLongTurn() {
    const fixture = yield* makeEngineFixture({
      behavior: {
        acknowledgement: 'Looking into it now.',
        failure: 'app-server connection dropped',
      },
    });
    fixture.push(inbound(1, 'investigate this deeply'));
    yield* settle(fixture.engine);
    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[0]).toBe('Looking into it now');
    expect(fixture.sent[1]).toContain('app-server connection dropped');
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Failed');
    fixture.remove();
  }),
);

it.effect('delivers one compacting notice before the final answer', () =>
  Effect.gen(function* compactingNotice() {
    const fixture = yield* makeEngineFixture({
      behavior: {
        acknowledgement: 'Looking into it now.',
        compactions: ['compact-1'],
        finalAnswer: 'Finished.',
      },
    });
    fixture.push(inbound(1, 'investigate this deeply'));
    yield* settle(fixture.engine);
    expect(fixture.sent).toStrictEqual(['Looking into it now', 'compacting...', 'Finished']);
    fixture.remove();
  }),
);

it.effect('advances a turn to failed after its bounded delivery path is exhausted', () =>
  Effect.gen(function* terminalDeliveryFailure() {
    const fixture = yield* makeEngineFixture({
      behavior: { deliveryFailure: 'chat.db unavailable' },
    });
    fixture.push(inbound(1, 'hello Spike'));
    yield* settle(fixture.engine);
    yield* settle(fixture.engine);
    expect(fixture.sent).toStrictEqual(['Done']);
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Failed');
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM outbound_messages').get()
        ?.state,
    ).toBe('Failed');
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM codex_attempts').get()
        ?.state,
    ).toBe('Failed');
    fixture.remove();
  }),
);

it.effect('terminates a fresh submission after its one reconciliation retry', () =>
  Effect.gen(function* boundedSubmissionFailure() {
    const fixture = yield* makeEngineFixture({
      behavior: { startFailure: 'turn start unavailable' },
    });
    fixture.push(inbound(1, 'hello Spike'));
    yield* settle(fixture.engine);
    yield* settle(fixture.engine);
    expect(fixture.inputs).toStrictEqual(['hello Spike', 'hello Spike']);
    expect(fixture.sent).toStrictEqual(['Spike hit an error: turn start unavailable']);
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Failed');
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM codex_attempts').get()
        ?.state,
    ).toBe('Failed');
    fixture.remove();
  }),
);

it.effect('fails the persisted follow-up turn when its start side effect fails', () =>
  Effect.gen(function* failedFollowUpStart() {
    const gate = Promise.withResolvers<undefined>();
    const fixture = yield* makeEngineFixture({
      behavior: {
        finalAnswer: 'First finished.',
        gate: gate.promise,
        startFailure: 'follow-up start unavailable',
        startFailureAfter: 1,
      },
    });
    fixture.push(inbound(1, 'first request'));
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    fixture.push(inbound(2, 'follow-up request'));
    yield* fixture.engine.pollOnce;
    gate.resolve();
    yield* fixture.engine.drain;

    expect(fixture.inputs).toStrictEqual([
      'first request',
      'follow-up request',
      'follow-up request',
    ]);
    expect(fixture.sent).toStrictEqual([
      'First finished',
      'Spike hit an error: follow-up start unavailable',
    ]);
    expect(
      fixture.database
        .query<{ state: string }, []>('SELECT state FROM logical_turns ORDER BY sequence')
        .all(),
    ).toStrictEqual([{ state: 'Completed' }, { state: 'Failed' }]);
    expect((yield* fixture.engine.snapshot).active).toBeNull();
    fixture.engine.close();
    fixture.remove();
  }),
);

it.effect('fails an active turn when its persisted steer side effect fails', () =>
  Effect.gen(function* failedSteer() {
    const gate = Promise.withResolvers<undefined>();
    const fixture = yield* makeEngineFixture({
      behavior: { gate: gate.promise, steerFailure: 'follow-up steer unavailable' },
    });
    fixture.push(inbound(1, 'first request'));
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    fixture.push(inbound(2, 'follow-up detail'));
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(3100));
    yield* Effect.promise(() => Bun.sleep(0));

    expect(fixture.steers).toStrictEqual(['follow-up detail', 'follow-up detail']);
    expect(fixture.sent).toStrictEqual(['Spike hit an error: follow-up steer unavailable']);
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Failed');
    expect((yield* fixture.engine.snapshot).active).toBeNull();

    gate.reject(new Error('monitor stopped after the steer failure'));
    yield* fixture.engine.drain;
    expect(fixture.sent).toStrictEqual(['Spike hit an error: follow-up steer unavailable']);
    fixture.engine.close();
    fixture.remove();
  }),
);

it.effect('quarantines a generation when a pool-timer steer finds a legacy attempt', () =>
  Effect.gen(function* quarantinedPoolTimerFailure() {
    const gate = Promise.withResolvers<undefined>();
    const fixture = yield* makeEngineFixture({ behavior: { gate: gate.promise } });
    fixture.push(inbound(1, 'first request'));
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));

    const { active } = yield* fixture.engine.snapshot;
    const activeLogicalTurnId =
      active === null
        ? yield* Effect.die(new Error('expected an active turn before scheduling pooled input'))
        : active.logicalTurnId;
    fixture.database.run(
      `INSERT INTO codex_attempts(
         id, logical_turn_id, account_id, state, input_fingerprint, frontier_json,
         submission_kind, started_at
       ) VALUES (
         'legacy-steer', ?, 'test-account', 'Prepared', 'legacy',
         '{"itemIds":[],"turnIds":[]}', 'Steer', '2026-07-14T12:00:01.000Z'
       )`,
      [activeLogicalTurnId],
    );

    fixture.push(inbound(2, 'follow-up detail'));
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(3100));
    yield* Effect.promise(() => Bun.sleep(0));

    expect(fixture.steers).toStrictEqual([]);
    expect(fixture.sent).toStrictEqual([
      'Spike hit an error: a legacy Codex attempt has no durable input batch identity; send /new',
    ]);
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Failed');
    expect((yield* fixture.engine.snapshot).active).toBeNull();
    expect((yield* fixture.engine.snapshot).generationBroken).toBe(true);

    fixture.push(inbound(3, 'must remain quarantined'));
    yield* fixture.engine.pollOnce;
    expect(fixture.inputs).toStrictEqual(['first request']);
    expect(fixture.turnsStarted).toStrictEqual(['turn-1']);
    expect((yield* fixture.engine.snapshot).pool.map(({ text }) => text)).toStrictEqual([
      'must remain quarantined',
    ]);

    gate.reject(new Error('monitor stopped after generation quarantine'));
    yield* fixture.engine.drain;
    expect(fixture.sent).toHaveLength(1);
    fixture.engine.close();
    fixture.remove();
  }),
);

it.effect('/new suppresses a late failure from the superseded monitor', () =>
  Effect.gen(function* supersededMonitorFailure() {
    const gate = Promise.withResolvers<undefined>();
    const fixture = yield* makeEngineFixture({ behavior: { gate: gate.promise } });
    fixture.push(inbound(1, 'first request'));
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    fixture.push(inbound(2, '/new'));
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    expect(fixture.sent).toStrictEqual(['New chat started']);

    gate.reject(new Error('superseded monitor disconnected'));
    yield* fixture.engine.drain;
    expect(fixture.sent).toStrictEqual(['New chat started']);
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Superseded');
    expect((yield* fixture.engine.snapshot).active).toBeNull();
    fixture.engine.close();
    fixture.remove();
  }),
);

it.effect('redispatches a durably ingested message after a crash advanced the inbox cursor', () =>
  Effect.gen(function* replayInbound() {
    const fixture = yield* makeEngineFixture({ behavior: { finalAnswer: 'Recovered.' } });
    const journal = makeJournal(fixture.database, { chatGuid: CHAT_GUID, handle: '+15555550199' });
    yield* journal.ingestObservedMessages(CHAT_GUID, new Date('2026-07-14T12:00:00.000Z'), [
      inbound(1, 'survive restart'),
    ]);
    yield* settle(fixture.engine);
    expect(fixture.sent).toStrictEqual(['Recovered']);
    expect(fixture.turnsStarted).toStrictEqual(['turn-1']);
    fixture.remove();
  }),
);

it.effect('persists an idle frontier and ingests the next inbound exactly once', () =>
  Effect.gen(function* idleFrontier() {
    const fixture = yield* makeEngineFixture({
      behavior: { finalAnswer: 'After idle.' },
      idleFrontier: 100,
      prepare: (database) =>
        Effect.sync(() => {
          database.run(
            `INSERT INTO inbox_cursor(chat_guid, last_rowid, last_message_guid, updated_at)
             VALUES (?, 0, NULL, ?)`,
            [CHAT_GUID, new Date('2026-07-14T11:59:00.000Z').toISOString()],
          );
        }),
    });
    yield* fixture.engine.pollOnce;
    expect(
      fixture.database
        .query<{ last_rowid: number }, []>('SELECT last_rowid FROM inbox_cursor')
        .get()?.last_rowid,
    ).toBe(100);

    fixture.push(inbound(101, 'arrived after idle'));
    yield* settle(fixture.engine);
    yield* fixture.engine.pollOnce;
    expect(fixture.inputs).toStrictEqual(['arrived after idle']);
    expect(fixture.sent).toStrictEqual(['After idle']);
    expect(
      fixture.database
        .query<{ last_rowid: number }, []>('SELECT last_rowid FROM inbox_cursor')
        .get()?.last_rowid,
    ).toBe(101);
    fixture.remove();
  }),
);

it.effect('seeds a fresh journal at the current chat frontier without replaying history', () =>
  Effect.gen(function* freshInstall() {
    const fixture = yield* makeEngineFixture({ preexisting: [inbound(391, 'old chat')] });
    yield* settle(fixture.engine);
    expect(fixture.sent).toStrictEqual([]);
    expect(fixture.turnsStarted).toStrictEqual([]);
    expect(
      fixture.database
        .query<{ last_rowid: number }, []>('SELECT last_rowid FROM inbox_cursor')
        .get()?.last_rowid,
    ).toBe(391);
    fixture.remove();
  }),
);

it.effect('retries a failed due redaction before advancing its six-hour watermark', () =>
  Effect.gen(function* periodicRedaction() {
    let currentTime = new Date('2026-08-15T12:00:00.000Z');
    const fixture = yield* makeEngineFixture({
      now: () => currentTime,
      prepare: (database) =>
        Effect.sync(() => {
          database.run(
            `INSERT INTO failures(correlation_id, operation, error_tag, message, created_at)
             VALUES ('old-private-failure', 'test', 'PrivateFailure', 'old private failure',
                     '2026-06-01T00:00:00.000Z')`,
          );
        }),
    });

    yield* fixture.engine.pollOnce;
    expect(
      fixture.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM failures').get()
        ?.count,
    ).toBe(1);

    currentTime = new Date('2026-08-15T18:00:00.000Z');
    fixture.database.run(
      `CREATE TEMP TRIGGER fail_redaction BEFORE DELETE ON failures
       BEGIN SELECT RAISE(ABORT, 'one-shot redaction failure'); END`,
    );
    yield* fixture.engine.pollOnce;
    expect(
      fixture.database
        .query<{ message: string }, []>('SELECT message FROM failures ORDER BY id')
        .all()
        .map(({ message }) => message),
    ).toContain('old private failure');

    fixture.database.run('DROP TRIGGER fail_redaction');
    yield* fixture.engine.pollOnce;
    expect(
      fixture.database
        .query<{ message: string }, []>('SELECT message FROM failures ORDER BY id')
        .all()
        .map(({ message }) => message),
    ).not.toContain('old private failure');
    fixture.remove();
  }),
);

it.effect('submits attachment-only inbound content without attempting a text Like', () =>
  Effect.gen(function* attachmentTurn() {
    const fixture = yield* makeEngineFixture({ behavior: { finalAnswer: 'Image received.' } });
    fixture.push({
      ...inbound(1, ''),
      attachments: [
        {
          attachmentGuid: 'attachment-1',
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          totalBytes: 42,
          transferName: null,
          uti: 'public.jpeg',
        },
      ],
      text: null,
    });
    yield* settle(fixture.engine);
    expect(fixture.inputs).toStrictEqual(['[Attachment: photo.jpg (image/jpeg)]']);
    expect(fixture.likes).toStrictEqual([]);
    expect(fixture.sent).toStrictEqual(['Image received']);
    fixture.remove();
  }),
);

it.effect('recovers local control replies consumed immediately before a crash', () =>
  Effect.gen(function* replayControls() {
    const fixture = yield* makeEngineFixture();
    const journal = makeJournal(fixture.database, { chatGuid: CHAT_GUID, handle: '+15555550199' });
    yield* journal.ingestObservedMessages(CHAT_GUID, new Date('2026-07-14T12:00:00.000Z'), [
      inbound(1, '/status'),
    ]);
    const [message] = yield* journal.listInbound;
    if (message === undefined) {
      throw new Error('expected persisted control');
    }
    fixture.database.run(
      "INSERT INTO handled_control_messages VALUES (?, '/status', '2026-07-14T12:00:00.000Z')",
      [message.id],
    );
    yield* settle(fixture.engine);
    expect(fixture.sent).toStrictEqual(['Spike ok · uptime 1m']);
    expect(fixture.turnsStarted).toStrictEqual([]);
    fixture.remove();
  }),
);

it.effect(
  'submits identical successive active-turn follow-ups without duplicating the work ack',
  () =>
    Effect.gen(function* pooledSteers() {
      const gate = Promise.withResolvers<undefined>();
      const fixture = yield* makeEngineFixture({
        behavior: {
          acknowledgement: 'Looking into it now.',
          finalAnswer: 'Finished.',
          gate: gate.promise,
        },
      });
      fixture.push(inbound(1, 'first request'));
      yield* fixture.engine.pollOnce;
      yield* Effect.promise(() => Bun.sleep(0));
      fixture.push(inbound(2, 'follow-up detail'));
      yield* fixture.engine.pollOnce;
      yield* Effect.promise(() => Bun.sleep(3100));
      yield* Effect.promise(() => Bun.sleep(0));
      fixture.push(inbound(3, 'follow-up detail'));
      yield* fixture.engine.pollOnce;
      yield* Effect.promise(() => Bun.sleep(3100));
      gate.resolve();
      yield* fixture.engine.drain;
      expect(fixture.steers).toStrictEqual(['follow-up detail', 'follow-up detail']);
      expect(fixture.sent).toStrictEqual(['Looking into it now', 'Finished']);
      fixture.remove();
    }),
  10_000,
);

it.effect('resumes and completes a turn whose terminal notification was lost before restart', () =>
  Effect.gen(function* recoveredCompletion() {
    const fixture = yield* makeEngineFixture({
      prepare: (database) =>
        Effect.sync(() => {
          seedActiveTurn(database);
        }),
      snapshot: {
        id: 'thread-1',
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'final-item',
                phase: 'final_answer',
                text: 'Recovered terminal answer.',
                type: 'agentMessage',
              },
            ],
            status: 'completed',
          },
        ],
      },
    });
    yield* settle(fixture.engine);
    expect(fixture.resumed).toStrictEqual(['thread-1']);
    expect(fixture.sent).toStrictEqual(['Recovered terminal answer']);
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Completed');
    fixture.remove();
  }),
);

it.effect(
  'forwards a lost-thread error and requires /new before accepting a clean generation',
  () =>
    Effect.gen(function* lostThreadReset() {
      const fixture = yield* makeEngineFixture({
        prepare: (database) =>
          Effect.sync(() => {
            seedActiveTurn(database);
          }),
        snapshot: { id: 'thread-1', turns: [] },
      });
      yield* settle(fixture.engine);
      expect(fixture.sent[0]).toContain('turn is missing; send /new');
      fixture.push(inbound(1, '/new'));
      yield* settle(fixture.engine);
      expect(fixture.sent.at(-1)).toBe('New chat started');
      const state = yield* fixture.engine.snapshot;
      expect(state.active).toBeNull();
      expect(state.codexThreadId).toBe('thread-new');
      fixture.remove();
    }),
);

it.effect('fails a missing persisted rollout once and remains idle until /new', () =>
  Effect.gen(function* missingRolloutReset() {
    const fixture = yield* makeEngineFixture({
      behavior: { resumeFailure: 'Codex thread is missing; send /new' },
      prepare: (database) =>
        Effect.sync(() => {
          seedActiveTurn(database);
          seedAcceptedAttempt(database);
        }),
    });
    yield* settle(fixture.engine);
    expect(fixture.resumed).toStrictEqual(['thread-1']);
    expect(fixture.sent).toStrictEqual(['Spike hit an error: Codex thread is missing; send /new']);
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Failed');
    expect((yield* fixture.engine.snapshot).active).toBeNull();
    expect((yield* fixture.engine.snapshot).generationBroken).toBe(true);

    fixture.push(inbound(1, 'do not retry this generation'));
    yield* settle(fixture.engine);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.turnsStarted).toHaveLength(0);

    fixture.push(inbound(2, '/new'));
    yield* settle(fixture.engine);
    expect(fixture.sent.at(-1)).toBe('New chat started');
    expect((yield* fixture.engine.snapshot).codexThreadId).toBe('thread-new');
    expect((yield* fixture.engine.snapshot).generationBroken).toBe(false);
    fixture.remove();
  }),
);

it.effect('terminates a non-generation startup recovery failure after one attempt', () =>
  Effect.gen(function* boundedRecoveryFailure() {
    const fixture = yield* makeEngineFixture({
      behavior: { resumeRuntimeFailure: 'app-server unavailable' },
      prepare: (database) =>
        Effect.sync(() => {
          seedActiveTurn(database);
        }),
    });
    yield* settle(fixture.engine);
    yield* settle(fixture.engine);
    expect(fixture.resumed).toStrictEqual(['thread-1']);
    expect(fixture.sent).toStrictEqual(['Spike hit an error: app-server unavailable']);
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Failed');
    fixture.remove();
  }),
);

it.effect('replaces an unused bound thread after the bind-before-first-turn crash window', () =>
  Effect.gen(function* replaceUnusedThread() {
    const fixture = yield* makeEngineFixture({
      behavior: {
        finalAnswer: 'Recovered first turn.',
        resumeFailure: 'Codex thread is missing; send /new',
      },
      prepare: (database) =>
        Effect.sync(() => {
          seedActiveTurn(database);
          database.run('UPDATE scheduler_state SET active_codex_turn_id = NULL');
        }),
      snapshot: {
        id: 'thread-new',
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'final-item',
                phase: 'final_answer',
                text: 'Recovered first turn.',
                type: 'agentMessage',
              },
            ],
            status: 'completed',
          },
        ],
      },
    });
    yield* settle(fixture.engine);
    expect({
      attempts: fixture.database
        .query<{ state: string }, []>('SELECT state FROM codex_attempts')
        .all(),
      failures: fixture.database
        .query<{ error_tag: string; message: string }, []>(
          'SELECT error_tag, message FROM failures',
        )
        .all(),
      resumed: fixture.resumed,
      thread: fixture.database
        .query<{ codex_thread_id: string }, []>(
          "SELECT codex_thread_id FROM generations WHERE state = 'Current'",
        )
        .get()?.codex_thread_id,
      turnsStarted: fixture.turnsStarted,
    }).toStrictEqual({
      attempts: [{ state: 'Completed' }],
      failures: [],
      resumed: ['thread-1'],
      thread: 'thread-new',
      turnsStarted: ['turn-1'],
    });
    expect(fixture.sent).toStrictEqual(['Recovered first turn']);
    expect(fixture.reads).toStrictEqual([]);
    expect(
      fixture.database
        .query<{ codex_thread_id: string }, []>(
          "SELECT codex_thread_id FROM generations WHERE state = 'Current'",
        )
        .get()?.codex_thread_id,
    ).toBe('thread-new');
    expect((yield* fixture.engine.snapshot).generationBroken).toBe(false);
    fixture.remove();
  }),
);
