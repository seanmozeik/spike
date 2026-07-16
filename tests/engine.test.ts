import type { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { MessageGuid, MessagesRowId } from '../src/domain/ids';
import type { ObservedMessage } from '../src/domain/inbound';
import { makeJournal } from '../src/journal/service';
import { CHAT_GUID, makeEngineFixture, settle } from './engine-fixture';

const inbound = (rowId: number, text: string): ObservedMessage => ({
  attachments: [],
  chatGuid: CHAT_GUID,
  handle: '+15555550199',
  isFromMe: false,
  messageGuid: MessageGuid.make(`message-${rowId}`),
  rowId: MessagesRowId.make(rowId),
  sentAt: new Date('2026-07-14T11:59:00.000Z'),
  service: 'iMessage',
  text,
});

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
       id, logical_turn_id, account_id, state, codex_thread_id, codex_turn_id,
       input_fingerprint, frontier_json, submission_kind, started_at
     ) VALUES (
       'attempt-1', 'logical-turn', 'test-account', 'Accepted', 'thread-1', 'turn-1',
       'fingerprint', '{"turnIds":[],"itemIds":[]}', 'Start', '2026-07-14T12:00:00.000Z'
     )`,
  );
};

it.effect('runs a quick direct-conversation turn with only one final bubble', () =>
  Effect.gen(function* quickTurn() {
    const fixture = yield* makeEngineFixture({ finalAnswer: 'Quick answer.' });
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
    const fixture = yield* makeEngineFixture({ finalAnswer: 'First answer.' });
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
    const fixture = yield* makeEngineFixture({ statusFailure: 'status snapshot unavailable' });
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
      acknowledgement: 'Looking into it now.',
      failure: 'app-server connection dropped',
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
      acknowledgement: 'Looking into it now.',
      compactions: ['compact-1'],
      finalAnswer: 'Finished.',
    });
    fixture.push(inbound(1, 'investigate this deeply'));
    yield* settle(fixture.engine);
    expect(fixture.sent).toStrictEqual(['Looking into it now', 'compacting...', 'Finished']);
    fixture.remove();
  }),
);

it.effect('advances a turn to failed after its bounded delivery path is exhausted', () =>
  Effect.gen(function* terminalDeliveryFailure() {
    const fixture = yield* makeEngineFixture({ deliveryFailure: 'chat.db unavailable' });
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
    const fixture = yield* makeEngineFixture({ startFailure: 'turn start unavailable' });
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

it.effect('redispatches a durably ingested message after a crash advanced the inbox cursor', () =>
  Effect.gen(function* replayInbound() {
    const fixture = yield* makeEngineFixture({ finalAnswer: 'Recovered.' });
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

it.effect('seeds a fresh journal at the current chat frontier without replaying history', () =>
  Effect.gen(function* freshInstall() {
    const fixture = yield* makeEngineFixture({}, undefined, undefined, [inbound(391, 'old chat')]);
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

it.effect('submits attachment-only inbound content without attempting a text Like', () =>
  Effect.gen(function* attachmentTurn() {
    const fixture = yield* makeEngineFixture({ finalAnswer: 'Image received.' });
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

it.effect('pools an active-turn follow-up into one steer without duplicating the work ack', () =>
  Effect.gen(function* pooledSteer() {
    const gate = Promise.withResolvers<undefined>();
    const fixture = yield* makeEngineFixture({
      acknowledgement: 'Looking into it now.',
      finalAnswer: 'Finished.',
      gate: gate.promise,
    });
    fixture.push(inbound(1, 'first request'));
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    fixture.push(inbound(2, 'follow-up detail'));
    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(3100));
    gate.resolve();
    yield* fixture.engine.drain;
    expect(fixture.steers).toStrictEqual(['follow-up detail']);
    expect(fixture.sent).toStrictEqual(['Looking into it now', 'Finished']);
    fixture.remove();
  }),
);

it.effect('resumes and completes a turn whose terminal notification was lost before restart', () =>
  Effect.gen(function* recoveredCompletion() {
    const fixture = yield* makeEngineFixture(
      {},
      {
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
      (database) =>
        Effect.sync(() => {
          seedActiveTurn(database);
        }),
    );
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
      const fixture = yield* makeEngineFixture({}, { id: 'thread-1', turns: [] }, (database) =>
        Effect.sync(() => {
          seedActiveTurn(database);
        }),
      );
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
    const fixture = yield* makeEngineFixture(
      { resumeFailure: 'Codex thread is missing; send /new' },
      undefined,
      (database) =>
        Effect.sync(() => {
          seedActiveTurn(database);
          seedAcceptedAttempt(database);
        }),
    );
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
    const fixture = yield* makeEngineFixture(
      { resumeRuntimeFailure: 'app-server unavailable' },
      undefined,
      (database) =>
        Effect.sync(() => {
          seedActiveTurn(database);
        }),
    );
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
    const fixture = yield* makeEngineFixture(
      { finalAnswer: 'Recovered first turn.', resumeFailure: 'Codex thread is missing; send /new' },
      {
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
      (database) =>
        Effect.sync(() => {
          seedActiveTurn(database);
          database.run('UPDATE scheduler_state SET active_codex_turn_id = NULL');
        }),
    );
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
