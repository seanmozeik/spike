import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';

import { openJournal } from '../src/database';
import {
  AccountId,
  CodexThreadId,
  GenerationId,
  InboundMessageId,
  InputBatchId,
  LogicalTurnId,
} from '../src/domain/ids';
import { makeCodexJournal } from '../src/journal/codex-journal';
import { makeSchedulerJournal } from '../src/journal/scheduler-journal';
import { makeScheduleJournal } from '../src/schedule/journal';
import type { ScheduleRequestScheduler } from '../src/schedule/pending-tool-calls';
import { makeScheduleServerRequests } from '../src/schedule/server-requests';
import { transitionScheduler } from '../src/scheduler/transition';
import { makeRuntimeHarness } from './fake-codex-runtime';

const roots: string[] = [];
const NOW = new Date('2026-07-19T12:00:00.000Z');

const makeManualScheduler = (): {
  readonly runNext: () => void;
  readonly scheduler: ScheduleRequestScheduler;
} => {
  const tasks: { cancelled: boolean; readonly run: () => void }[] = [];
  return {
    runNext: () => {
      const task = tasks.shift();
      if (task !== undefined && !task.cancelled) {
        task.run();
      }
    },
    scheduler: {
      schedule: (_delayMs, run) => {
        const task = { cancelled: false, run };
        tasks.push(task);
        return (): void => {
          task.cancelled = true;
        };
      },
    },
  };
};

const cleanupFixtures = (): void => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
};

const prepareTurn = Effect.fn('Test.prepareScheduleServerRequestTurn')(
  function* prepareScheduleServerRequestTurn(database: Database) {
    const scheduler = makeSchedulerJournal(database);
    const codex = makeCodexJournal(database);
    const initial = yield* scheduler.loadOrCreate(NOW);
    const inboundId = InboundMessageId.make('inbound-current');
    database.run(
      `INSERT INTO inbound_messages(
         id, source_kind, source_id, message_guid, messages_rowid, chat_guid, handle,
         service, text, sent_at, observed_at
       ) VALUES (?, 'Messages', ?, ?, 1, 'chat', 'handle', 'iMessage', 'set a reminder', ?, ?)`,
      [inboundId, 'message-current', 'message-current', NOW.toISOString(), NOW.toISOString()],
    );
    const logicalTurnId = LogicalTurnId.make('logical-current');
    const started = transitionScheduler(initial, {
      kind: 'Inbound',
      message: { attachments: [], id: inboundId, receivedAt: NOW, text: 'set a reminder' },
      newGenerationId: GenerationId.make('unused-generation'),
      nextLogicalTurnId: logicalTurnId,
    });
    yield* scheduler.commitTransition(started, NOW);
    const threadId = CodexThreadId.make('thread-current');
    yield* codex.bindGenerationThread(initial.generationId, threadId);
    const [batch] = yield* scheduler.loadInputBatches(logicalTurnId, 'Initial');
    if (batch === undefined) {
      throw new Error('expected initial input batch');
    }
    const attemptId = yield* codex.beginCodexAttempt({
      accountId: AccountId.make('test-account'),
      batchId: InputBatchId.make(batch.id),
      fingerprint: 'fingerprint',
      frontier: { itemIds: [], turnIds: [] },
      logicalTurnId,
      startedAt: NOW,
      submissionKind: 'Start',
      threadId,
    });
    return { attemptId, codex, threadId };
  },
);

const makeFixture = Effect.fn('Test.makeScheduleServerRequestFixture')(
  function* makeScheduleServerRequestFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-schedule-rpc-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    const { attemptId, codex, threadId } = yield* prepareTurn(handle.database);
    const { runtime, trace } = makeRuntimeHarness({}, { id: threadId, turns: [] });
    const errors: unknown[] = [];
    let mutations = 0;
    const scheduled = makeManualScheduler();
    const requests = makeScheduleServerRequests({
      database: handle.database,
      journal: makeScheduleJournal(handle.database),
      now: () => NOW,
      onError: (cause) => {
        errors.push(cause);
      },
      onMutation: () => {
        mutations += 1;
      },
      pendingTimeoutMs: 10,
      runtime,
      scheduler: scheduled.scheduler,
    });
    return {
      attemptId,
      codex,
      database: handle.database,
      errors,
      handle,
      mutations: (): number => mutations,
      requests,
      scheduled,
      threadId,
      trace,
    };
  },
);

interface ScheduleToolRequest {
  readonly id: string;
  readonly method: 'item/tool/call';
  readonly params: {
    readonly arguments: {
      readonly oneShotAt: string;
      readonly prompt: string;
      readonly timezone: string;
    };
    readonly callId: string;
    readonly namespace: 'schedule';
    readonly threadId: 'thread-current';
    readonly tool: 'create';
    readonly turnId: string;
  };
}

const createCall = (
  callId: string,
  turnId: string,
  prompt = 'Send the reminder',
): ScheduleToolRequest => ({
  id: callId,
  method: 'item/tool/call',
  params: {
    arguments: { oneShotAt: '2026-07-20T12:00:00Z', prompt, timezone: 'Europe/London' },
    callId,
    namespace: 'schedule',
    threadId: 'thread-current',
    tool: 'create',
    turnId,
  },
});

const publish = (
  listeners: readonly ((request: ReturnType<typeof createCall>) => void)[],
  request: ReturnType<typeof createCall>,
): void => {
  for (const listener of listeners) {
    listener(request);
  }
};

export { cleanupFixtures, createCall, makeFixture, NOW, publish };
