import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';

import type { ThreadSnapshot } from '../src/codex/reconcile';
import type { CodexServerRequest, JsonRpcId } from '../src/codex/server-request-registry';
import { makeConversationPolicy, type ConversationPolicy } from '../src/conversation-policy';
import type { JournalHandle } from '../src/database';
import { MessagesDeliveryError } from '../src/delivery/error';
import { makeDeliveryJournal } from '../src/delivery/journal';
import {
  type MessagesTransport,
  withConversationAvailability,
} from '../src/delivery/messages-transport';
import { makeDeliveryService } from '../src/delivery/service';
import { ChatGuid, MessageGuid, MessagesRowId } from '../src/domain/ids';
import type { ObservedMessage } from '../src/domain/inbound';
import { makeConversationDiagnostic } from '../src/journal/conversation-diagnostic';
import type { LikeAcknowledgement } from '../src/like/adapter';
import { makeSpikeEngine, type SpikeEngine } from '../src/service/engine';
import { makeInbox } from './engine-inbox-fixture';
import { openFixtureJournal } from './engine-journal-fixture';
import { makeRuntimeHarness, type RuntimeTrace, type TurnBehavior } from './fake-codex-runtime';

interface EngineFixture {
  readonly closeCodexConnection: () => void;
  readonly conversation: ConversationPolicy;
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
  readonly conversationProbe?: () => Effect.Effect<void, unknown>;
  readonly conversationValidationIntervalMs?: number;
  readonly idleFrontier?: number;
  readonly like?: LikeAcknowledgement;
  readonly now?: () => Date;
  readonly prepare?: (database: Database) => Effect.Effect<void, unknown>;
  readonly preexisting?: readonly ObservedMessage[];
  readonly snapshot?: ThreadSnapshot;
}

const CHAT_GUID = ChatGuid.make('any;-;+15555550199');

const inbound = (rowId: number, text: string): ObservedMessage => ({
  attachments: [],
  chatGuid: CHAT_GUID,
  handle: '+15555550199',
  isFromMe: false,
  messageGuid: MessageGuid.make(`message-${String(rowId)}`),
  rowId: MessagesRowId.make(rowId),
  sentAt: new Date('2026-07-14T11:59:00.000Z'),
  service: 'iMessage',
  text,
});

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
  refresh: Effect.void,
  send: (text): Effect.Effect<void> =>
    Effect.sync(() => {
      sent.push(text);
    }),
});

const makeTestDelivery = (
  handle: JournalHandle,
  sent: string[],
  behavior: TurnBehavior,
  conversation: ConversationPolicy,
): ReturnType<typeof makeDeliveryService> =>
  makeDeliveryService(
    makeDeliveryJournal(handle.database),
    withConversationAvailability(makeTransport(sent, behavior), conversation),
  );

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
  readonly conversation: ConversationPolicy;
  readonly engine: SpikeEngine;
  readonly handle: JournalHandle;
  readonly likes: string[];
  readonly queue: ObservedMessage[];
  readonly root: string;
  readonly sent: string[];
  readonly trace: RuntimeTrace;
}

interface MakeFixtureOptions {
  readonly beforeOpen: ((databasePath: string) => void) | undefined;
  readonly behavior: TurnBehavior;
  readonly conversationProbe: () => Effect.Effect<void, unknown>;
  readonly conversationValidationIntervalMs: number | undefined;
  readonly idleFrontier: number | undefined;
  readonly like: LikeAcknowledgement | undefined;
  readonly now: () => Date;
  readonly prepare: ((database: Database) => Effect.Effect<void, unknown>) | undefined;
  readonly preexisting: readonly ObservedMessage[] | undefined;
  readonly snapshot: ThreadSnapshot | undefined;
}

const buildFixture = ({
  conversation,
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
  conversation,
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

const makeFixture = Effect.fn('Test.makeEngineFixture')(function* makeFixture({
  beforeOpen,
  behavior,
  conversationProbe,
  conversationValidationIntervalMs,
  idleFrontier,
  like,
  now,
  prepare,
  preexisting,
  snapshot,
}: MakeFixtureOptions) {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-engine-'));
  const databasePath = path.join(root, 'spike.db');
  const handle = yield* openFixtureJournal(databasePath, beforeOpen);
  const likes: string[] = [],
    sent: string[] = [];
  const queue: ObservedMessage[] = [...(preexisting ?? [])];
  if (prepare !== undefined) {
    yield* prepare(handle.database);
  }
  const threadSnapshot = snapshot ?? { id: 'thread-1', turns: [] };
  const { runtime, trace } = makeRuntimeHarness(behavior, threadSnapshot);
  const conversation = yield* makeConversationPolicy({
    diagnostic: makeConversationDiagnostic(handle.database),
    initialValidationAt: now(),
    probe: conversationProbe,
    ...(conversationValidationIntervalMs === undefined
      ? {}
      : { validationIntervalMs: conversationValidationIntervalMs }),
  });
  const engine = yield* makeSpikeEngine({
    ...(behavior.approvalExpiryMs === undefined
      ? {}
      : { approvalExpiryMs: behavior.approvalExpiryMs }),
    chatGuid: CHAT_GUID,
    conversation,
    database: handle.database,
    delivery: makeTestDelivery(handle, sent, behavior, conversation),
    handle: '+15555550199',
    inbox: makeInbox(queue, idleFrontier),
    like: like ?? makeLike(likes),
    now,
    renderStatus: () => renderStatus(behavior),
    runtime,
  });
  return buildFixture({ conversation, engine, handle, likes, queue, root, sent, trace });
});

const makeEngineFixture = (options: EngineFixtureOptions = {}): ReturnType<typeof makeFixture> =>
  makeFixture({
    beforeOpen: undefined,
    behavior: options.behavior ?? {},
    conversationProbe: options.conversationProbe ?? ((): Effect.Effect<void> => Effect.void),
    conversationValidationIntervalMs: options.conversationValidationIntervalMs,
    idleFrontier: options.idleFrontier,
    like: options.like,
    now: options.now ?? ((): Date => new Date('2026-07-14T12:00:00.000Z')),
    preexisting: options.preexisting,
    prepare: options.prepare,
    snapshot: options.snapshot,
  });

const makeMigratedEngineFixture = (
  behavior: TurnBehavior,
  snapshot: ThreadSnapshot,
  beforeOpen: (databasePath: string) => void,
): ReturnType<typeof makeFixture> =>
  makeFixture({
    beforeOpen,
    behavior,
    conversationProbe: (): Effect.Effect<void> => Effect.void,
    conversationValidationIntervalMs: undefined,
    idleFrontier: undefined,
    like: undefined,
    now: (): Date => new Date('2026-07-14T12:00:00.000Z'),
    preexisting: undefined,
    prepare: undefined,
    snapshot,
  });

const settle = (engine: SpikeEngine): Effect.Effect<void, unknown> =>
  Effect.gen(function* settleEngine() {
    yield* engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    yield* engine.drain;
  });

export { CHAT_GUID, inbound, makeEngineFixture, makeMigratedEngineFixture, settle };
export type { EngineFixture };
export type { TurnBehavior } from './fake-codex-runtime';
