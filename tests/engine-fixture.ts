import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';

import type { ClassifiedOutput } from '../src/codex/output-classifier';
import type { ThreadSnapshot } from '../src/codex/reconcile';
import type { CodexRuntime } from '../src/codex/runtime';
import { openJournal, type JournalHandle } from '../src/database';
import { MessagesDeliveryError } from '../src/delivery/error';
import { makeDeliveryJournal } from '../src/delivery/journal';
import type { MessagesTransport } from '../src/delivery/messages-transport';
import { makeDeliveryService } from '../src/delivery/service';
import { ChatGuid, CodexThreadId, CodexTurnId, MessagesRowId } from '../src/domain/ids';
import type { ObservedMessage } from '../src/domain/inbound';
import { CodexRuntimeError, GenerationBroken } from '../src/errors';
import type { LikeAcknowledgement } from '../src/like/adapter';
import type { MessagesInboxHandle } from '../src/messages-inbox';
import { makeSpikeEngine, type SpikeEngine } from '../src/service/engine';

interface TurnBehavior {
  readonly acknowledgement?: string;
  readonly compactions?: readonly string[];
  readonly deliveryFailure?: string;
  readonly failure?: string;
  readonly finalAnswer?: string;
  readonly gate?: Promise<void>;
  readonly resumeFailure?: string;
  readonly resumeRuntimeFailure?: string;
  readonly startFailure?: string;
  readonly statusFailure?: string;
}

interface EngineFixture {
  readonly database: Database;
  readonly engine: SpikeEngine;
  readonly handle: JournalHandle;
  readonly inputs: string[];
  readonly likes: string[];
  readonly push: (...messages: readonly ObservedMessage[]) => void;
  readonly reads: string[];
  readonly remove: () => void;
  readonly resumed: string[];
  readonly sent: string[];
  readonly steers: string[];
  readonly turnsStarted: string[];
}

interface RuntimeTrace {
  readonly inputs: string[];
  readonly reads: string[];
  readonly resumed: string[];
  readonly steers: string[];
  readonly turnsStarted: string[];
}

const CHAT_GUID = ChatGuid.make('any;-;+15555550199');

const renderStatus = (behavior: TurnBehavior): Promise<string> =>
  behavior.statusFailure === undefined
    ? Promise.resolve('Spike ok · uptime 1m')
    : Promise.reject(new Error(behavior.statusFailure));

const makeWaitForTurn =
  (behavior: TurnBehavior): CodexRuntime['waitForTurn'] =>
  (_threadId, _turnId, handlers) =>
    Effect.gen(function* wait() {
      if (behavior.acknowledgement !== undefined) {
        handlers.onAcknowledgement(behavior.acknowledgement);
      }
      for (const itemId of behavior.compactions ?? []) {
        handlers.onCompactionStarted(itemId);
      }
      if (behavior.failure !== undefined) {
        return yield* new CodexRuntimeError({
          cause: new Error(behavior.failure),
          message: behavior.failure,
          operation: 'turn/wait',
        });
      }
      if (behavior.gate !== undefined) {
        yield* Effect.promise(() => behavior.gate ?? Promise.resolve());
      }
      return {
        acknowledgement: behavior.acknowledgement ?? null,
        finalAnswer: behavior.finalAnswer ?? 'Done.',
      } satisfies ClassifiedOutput;
    });

const makeResumeThread =
  (
    behavior: TurnBehavior,
    trace: RuntimeTrace,
    loaded: Set<string>,
  ): CodexRuntime['resumeThread'] =>
  (threadId) => {
    trace.resumed.push(threadId);
    if (behavior.resumeRuntimeFailure !== undefined) {
      return new CodexRuntimeError({
        cause: new Error(behavior.resumeRuntimeFailure),
        message: behavior.resumeRuntimeFailure,
        operation: 'thread/resume',
      });
    }
    if (behavior.resumeFailure !== undefined) {
      return new GenerationBroken({ message: behavior.resumeFailure });
    }
    loaded.add(threadId);
    return Effect.void;
  };

const makeStartTurn =
  (behavior: TurnBehavior, trace: RuntimeTrace): CodexRuntime['startTurn'] =>
  ({ input }) =>
    Effect.gen(function* startTurn() {
      trace.inputs.push(input);
      if (behavior.startFailure !== undefined) {
        return yield* new CodexRuntimeError({
          cause: new Error(behavior.startFailure),
          message: behavior.startFailure,
          operation: 'turn/start',
        });
      }
      const turnId = `turn-${trace.turnsStarted.length + 1}`;
      trace.turnsStarted.push(turnId);
      return CodexTurnId.make(turnId);
    });

const makeRuntime = (
  behavior: TurnBehavior,
  trace: RuntimeTrace,
  snapshot: ThreadSnapshot,
): CodexRuntime => {
  const loaded = new Set<string>();
  return {
    accountId: 'test-account',
    archiveThread: (): Effect.Effect<void> => Effect.void,
    close: (): Promise<void> => Promise.resolve(),
    health: Effect.void,
    interruptTurn: (): Effect.Effect<void> => Effect.void,
    loadedThreads: Effect.sync(() => [...loaded].map((id) => CodexThreadId.make(id))),
    rateLimits: Effect.succeed({}),
    readThread: (threadId): Effect.Effect<ThreadSnapshot> =>
      Effect.sync(() => {
        trace.reads.push(threadId);
        return snapshot;
      }),
    resumeThread: makeResumeThread(behavior, trace, loaded),
    startThread: Effect.sync(() => {
      const threadId = CodexThreadId.make('thread-new');
      loaded.add(threadId);
      return threadId;
    }),
    startTurn: makeStartTurn(behavior, trace),
    steerTurn: ({ input }): Effect.Effect<void> =>
      Effect.sync(() => {
        trace.steers.push(input);
      }),
    usage: Effect.succeed({}),
    waitForTurn: makeWaitForTurn(behavior),
  };
};

const makeTransport = (sent: string[], behavior: TurnBehavior): MessagesTransport => ({
  close: (): void => undefined,
  findMatchingAfter: (_frontier, text): ReturnType<MessagesTransport['findMatchingAfter']> =>
    behavior.deliveryFailure === undefined
      ? Effect.succeed({ guid: `sent-${text}-${sent.length}`, rowId: sent.length })
      : Effect.fail(
          new MessagesDeliveryError({
            cause: new Error(behavior.deliveryFailure),
            message: behavior.deliveryFailure,
            operation: 'find',
          }),
        ),
  frontier: Effect.succeed(0),
  send: (text): Effect.Effect<void> =>
    Effect.sync(() => {
      sent.push(text);
    }),
});

const makeTestDelivery = (
  handle: JournalHandle,
  sent: string[],
  behavior: TurnBehavior,
): ReturnType<typeof makeDeliveryService> =>
  makeDeliveryService(makeDeliveryJournal(handle.database), makeTransport(sent, behavior));

const latestRowId = (queue: readonly ObservedMessage[]): MessagesRowId => {
  let latest = 0;
  for (const message of queue) {
    latest = Math.max(latest, message.rowId);
  }
  return MessagesRowId.make(latest);
};

const makeInbox = (queue: ObservedMessage[]): MessagesInboxHandle => ({
  close: (): void => undefined,
  frontier: Effect.sync(() => latestRowId(queue)),
  observeAfter: (cursor): Effect.Effect<readonly ObservedMessage[]> =>
    Effect.succeed(queue.filter(({ rowId }) => rowId > cursor)),
});

const makeLike = (likes: string[]): LikeAcknowledgement => ({
  acknowledge: (_id, text): Effect.Effect<void> =>
    Effect.sync(() => {
      likes.push(text);
    }),
  status: Effect.succeed({
    available: true,
    degraded: false,
    lastFailureAt: null,
    lastFailureReason: null,
    lastSuccessAt: null,
  }),
});

const makeEngineFixture = Effect.fn('Test.makeEngineFixture')(function* makeFixture(
  behavior: TurnBehavior = {},
  snapshot?: ThreadSnapshot,
  prepare?: (database: Database) => Effect.Effect<void, unknown>,
  preexisting?: readonly ObservedMessage[],
) {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-engine-'));
  const handle = yield* openJournal(path.join(root, 'spike.db'));
  const likes: string[] = [],
    sent: string[] = [];
  const queue: ObservedMessage[] = [...(preexisting ?? [])];
  const trace: RuntimeTrace = { inputs: [], reads: [], resumed: [], steers: [], turnsStarted: [] };
  if (prepare !== undefined) {
    yield* prepare(handle.database);
  }
  const threadSnapshot = snapshot ?? { id: 'thread-1', turns: [] };
  const runtime = makeRuntime(behavior, trace, threadSnapshot);
  const engine = yield* makeSpikeEngine({
    chatGuid: CHAT_GUID,
    database: handle.database,
    delivery: makeTestDelivery(handle, sent, behavior),
    handle: '+15555550199',
    inbox: makeInbox(queue),
    like: makeLike(likes),
    now: () => new Date('2026-07-14T12:00:00.000Z'),
    renderStatus: () => renderStatus(behavior),
    runtime,
  });
  return {
    database: handle.database,
    engine,
    handle,
    inputs: trace.inputs,
    likes,
    push: (...messages): void => {
      queue.push(...messages);
    },
    reads: trace.reads,
    remove: (): void => {
      handle.close();
      rmSync(root, { force: true, recursive: true });
    },
    resumed: trace.resumed,
    sent,
    steers: trace.steers,
    turnsStarted: trace.turnsStarted,
  } satisfies EngineFixture;
});

const settle = (engine: SpikeEngine): Effect.Effect<void, unknown> =>
  Effect.gen(function* settleEngine() {
    yield* engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    yield* engine.drain;
  });

export { CHAT_GUID, makeEngineFixture, settle };
export type { EngineFixture, TurnBehavior };
