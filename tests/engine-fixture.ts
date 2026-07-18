import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';

import type { ThreadSnapshot } from '../src/codex/reconcile';
import type { CodexServerRequest, JsonRpcId } from '../src/codex/server-request-registry';
import { openJournal, type JournalHandle } from '../src/database';
import { MessagesDeliveryError } from '../src/delivery/error';
import { makeDeliveryJournal } from '../src/delivery/journal';
import type { MessagesTransport } from '../src/delivery/messages-transport';
import { makeDeliveryService } from '../src/delivery/service';
import { ChatGuid, MessagesRowId } from '../src/domain/ids';
import type { ObservedMessage } from '../src/domain/inbound';
import type { LikeAcknowledgement } from '../src/like/adapter';
import type { MessagesInboxHandle } from '../src/messages-inbox';
import { makeSpikeEngine, type SpikeEngine } from '../src/service/engine';
import { makeRuntimeHarness, type RuntimeTrace, type TurnBehavior } from './fake-codex-runtime';

interface EngineFixture {
  readonly closeCodexConnection: () => void;
  readonly database: Database;
  readonly engine: SpikeEngine;
  readonly handle: JournalHandle;
  readonly inputs: string[];
  readonly likes: string[];
  readonly push: (...messages: readonly ObservedMessage[]) => void;
  readonly reads: string[];
  readonly requestApproval: (request: CodexServerRequest) => void;
  readonly resolveServerRequest: (id: JsonRpcId) => void;
  readonly remove: () => void;
  readonly responses: { readonly id: JsonRpcId; readonly result: unknown }[];
  readonly resumed: string[];
  readonly sent: string[];
  readonly steers: string[];
  readonly turnsStarted: string[];
}

interface EngineFixtureOptions {
  readonly behavior?: TurnBehavior;
  readonly now?: () => Date;
  readonly prepare?: (database: Database) => Effect.Effect<void, unknown>;
  readonly preexisting?: readonly ObservedMessage[];
  readonly snapshot?: ThreadSnapshot;
}

const CHAT_GUID = ChatGuid.make('any;-;+15555550199');

const renderStatus = (behavior: TurnBehavior): Promise<string> =>
  behavior.statusFailure === undefined
    ? Promise.resolve('Spike ok · uptime 1m')
    : Promise.reject(new Error(behavior.statusFailure));

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

interface FixtureParts {
  readonly engine: SpikeEngine;
  readonly handle: JournalHandle;
  readonly likes: string[];
  readonly queue: ObservedMessage[];
  readonly root: string;
  readonly sent: string[];
  readonly trace: RuntimeTrace;
}

const buildFixture = ({
  engine,
  handle,
  likes,
  queue,
  root,
  sent,
  trace,
}: FixtureParts): EngineFixture => ({
  closeCodexConnection: (): void => {
    for (const listener of trace.closeListeners) {
      listener();
    }
  },
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
  requestApproval: (request): void => {
    for (const listener of trace.requestListeners) {
      listener(request);
    }
  },
  resolveServerRequest: (id): void => {
    for (const listener of trace.notificationListeners) {
      listener({ method: 'serverRequest/resolved', params: { requestId: id } });
    }
  },
  responses: trace.responses,
  resumed: trace.resumed,
  sent,
  steers: trace.steers,
  turnsStarted: trace.turnsStarted,
});

const makeEngineFixture = Effect.fn('Test.makeEngineFixture')(function* makeFixture(
  options: EngineFixtureOptions = {},
) {
  const {
    behavior = {},
    now = (): Date => new Date('2026-07-14T12:00:00.000Z'),
    prepare,
    preexisting,
    snapshot,
  } = options;
  const root = mkdtempSync(path.join(tmpdir(), 'spike-engine-'));
  const handle = yield* openJournal(path.join(root, 'spike.db'));
  const likes: string[] = [],
    sent: string[] = [];
  const queue: ObservedMessage[] = [...(preexisting ?? [])];
  if (prepare !== undefined) {
    yield* prepare(handle.database);
  }
  const threadSnapshot = snapshot ?? { id: 'thread-1', turns: [] };
  const { runtime, trace } = makeRuntimeHarness(behavior, threadSnapshot);
  const engine = yield* makeSpikeEngine({
    ...(behavior.approvalExpiryMs === undefined
      ? {}
      : { approvalExpiryMs: behavior.approvalExpiryMs }),
    chatGuid: CHAT_GUID,
    database: handle.database,
    delivery: makeTestDelivery(handle, sent, behavior),
    handle: '+15555550199',
    inbox: makeInbox(queue),
    like: makeLike(likes),
    now,
    renderStatus: () => renderStatus(behavior),
    runtime,
  });
  return buildFixture({ engine, handle, likes, queue, root, sent, trace });
});

const settle = (engine: SpikeEngine): Effect.Effect<void, unknown> =>
  Effect.gen(function* settleEngine() {
    yield* engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    yield* engine.drain;
  });

export { CHAT_GUID, makeEngineFixture, settle };
export type { EngineFixture };
export type { TurnBehavior } from './fake-codex-runtime';
