import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';

import type { ThreadSnapshot } from '../src/codex/reconcile';
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
import { makeFailureLog, type FailureLog } from '../src/logging/failure-log';
import type { MessagesInboxHandle } from '../src/messages-inbox';
import type { OpenMessagesWatcher } from '../src/messages-watcher';
import { makeSpikeEngine, type SpikeEngine } from '../src/service/engine';
import { prepareAttachmentOptions } from './engine-attachment-fixture';
import type {
  EngineFixture as EngineFixtureShape,
  EngineFixtureOptions,
} from './engine-fixture-types';
import { makeInbox } from './engine-inbox-fixture';
import { openFixtureJournal } from './engine-journal-fixture';
import { makeEngineRuntimeControls } from './engine-runtime-controls';
import { makeRuntimeHarness, type RuntimeTrace, type TurnBehavior } from './fake-codex-runtime';

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
  readonly scanTrace: {
    failuresRemaining: number;
    readonly onScan: MakeFixtureOptions['onInboxScan'];
    scans: number;
  };
  readonly sent: string[];
  readonly trace: RuntimeTrace;
}

interface MakeFixtureOptions {
  readonly beforeOpen: ((databasePath: string) => void) | undefined;
  readonly behavior: TurnBehavior;
  readonly conversationProbe: () => Effect.Effect<void, unknown>;
  readonly conversationValidationIntervalMs: number | undefined;
  readonly failureLog: FailureLog;
  readonly idleFrontier: number | undefined;
  readonly inbox: MessagesInboxHandle | undefined;
  readonly inboxScanFailures: number;
  readonly like: LikeAcknowledgement | undefined;
  readonly messagesDebounceMs: number | undefined;
  readonly now: () => Date;
  readonly onInboxScan: ((scan: number) => Effect.Effect<void>) | undefined;
  readonly phaseRetryMs: number | undefined;
  readonly prepare: ((database: Database) => Effect.Effect<void, unknown>) | undefined;
  readonly preexisting: readonly ObservedMessage[] | undefined;
  readonly reconcileIntervalMs: number | undefined;
  readonly snapshot: ThreadSnapshot | undefined;
  readonly watchMessages: OpenMessagesWatcher | undefined;
}

const makeScanTrace = (options: MakeFixtureOptions): FixtureParts['scanTrace'] => ({
  failuresRemaining: options.inboxScanFailures,
  onScan: options.onInboxScan,
  scans: 0,
});

const buildFixture = ({
  conversation,
  engine,
  handle,
  likes,
  queue,
  root,
  scanTrace,
  sent,
  trace,
}: FixtureParts): EngineFixtureShape => ({
  archived: trace.archived,
  attachmentInputs: trace.attachmentInputs,
  attachmentStagingRoot: path.join(root, 'staged-attachments'),
  conversation,
  database: handle.database,
  engine,
  failNextInboxScans: (count = 1): void => {
    scanTrace.failuresRemaining += count;
  },
  handle,
  get inboxScans(): number {
    return scanTrace.scans;
  },
  inputs: trace.inputs,
  interrupted: trace.interrupted,
  likes,
  push: (...messages): void => {
    queue.push(...messages);
  },
  reads: trace.reads,
  remove: (): void => {
    handle.close();
    rmSync(root, { force: true, recursive: true });
  },
  responses: trace.responses,
  resumed: trace.resumed,
  ...makeEngineRuntimeControls(trace),
  sent,
  steers: trace.steers,
  turnsStarted: trace.turnsStarted,
});

const makeFixture = Effect.fn('Test.makeEngineFixture')(function* makeFixture(
  options: MakeFixtureOptions,
) {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-engine-'));
  const attachmentOptions = prepareAttachmentOptions(root);
  const handle = yield* openFixtureJournal(path.join(root, 'spike.db'), options.beforeOpen);
  const likes: string[] = [],
    sent: string[] = [];
  const queue: ObservedMessage[] = [...(options.preexisting ?? [])];
  const scanTrace = makeScanTrace(options);
  if (options.prepare !== undefined) {
    yield* options.prepare(handle.database);
  }
  const threadSnapshot = options.snapshot ?? { id: 'thread-1', turns: [] };
  const { runtime, trace } = makeRuntimeHarness(options.behavior, threadSnapshot);
  const conversation = yield* makeConversationPolicy({
    diagnostic: makeConversationDiagnostic(handle.database),
    initialValidationAt: options.now(),
    probe: options.conversationProbe,
    ...(options.conversationValidationIntervalMs === undefined
      ? {}
      : { validationIntervalMs: options.conversationValidationIntervalMs }),
  });
  const engine = yield* makeSpikeEngine({
    ...(options.behavior.approvalExpiryMs === undefined
      ? {}
      : { approvalExpiryMs: options.behavior.approvalExpiryMs }),
    ...attachmentOptions,
    chatGuid: CHAT_GUID,
    conversation,
    database: handle.database,
    delivery: makeTestDelivery(handle, sent, options.behavior, conversation),
    failureLog: options.failureLog,
    handle: '+15555550199',
    inbox: options.inbox ?? makeInbox(queue, options.idleFrontier, scanTrace),
    like: options.like ?? makeLike(likes),
    ...(options.messagesDebounceMs === undefined
      ? {}
      : { messagesDebounceMs: options.messagesDebounceMs }),
    now: options.now,
    ...(options.phaseRetryMs === undefined ? {} : { phaseRetryMs: options.phaseRetryMs }),
    ...(options.reconcileIntervalMs === undefined
      ? {}
      : { reconcileIntervalMs: options.reconcileIntervalMs }),
    renderStatus: () => renderStatus(options.behavior),
    runtime,
    ...(options.watchMessages === undefined ? {} : { watchMessages: options.watchMessages }),
  });
  return buildFixture({ conversation, engine, handle, likes, queue, root, scanTrace, sent, trace });
});

const silentFailureLog = (): FailureLog => makeFailureLog({ write: (): void => undefined });

const makeEngineFixture = (options: EngineFixtureOptions = {}): ReturnType<typeof makeFixture> =>
  makeFixture({
    beforeOpen: options.beforeOpen,
    behavior: options.behavior ?? {},
    conversationProbe: options.conversationProbe ?? ((): Effect.Effect<void> => Effect.void),
    conversationValidationIntervalMs: options.conversationValidationIntervalMs,
    failureLog: options.failureLog ?? silentFailureLog(),
    idleFrontier: options.idleFrontier,
    inbox: options.inbox,
    inboxScanFailures: options.inboxScanFailures ?? 0,
    like: options.like,
    messagesDebounceMs: options.messagesDebounceMs,
    now: options.now ?? ((): Date => new Date('2026-07-14T12:00:00.000Z')),
    onInboxScan: options.onInboxScan,
    phaseRetryMs: options.phaseRetryMs,
    preexisting: options.preexisting,
    prepare: options.prepare,
    reconcileIntervalMs: options.reconcileIntervalMs,
    snapshot: options.snapshot,
    watchMessages: options.watchMessages,
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
    failureLog: silentFailureLog(),
    idleFrontier: undefined,
    inbox: undefined,
    inboxScanFailures: 0,
    like: undefined,
    messagesDebounceMs: undefined,
    now: (): Date => new Date('2026-07-14T12:00:00.000Z'),
    onInboxScan: undefined,
    phaseRetryMs: undefined,
    preexisting: undefined,
    prepare: undefined,
    reconcileIntervalMs: undefined,
    snapshot,
    watchMessages: undefined,
  });

const settle = (engine: SpikeEngine): Effect.Effect<void, unknown> =>
  Effect.gen(function* settleEngine() {
    yield* engine.pollOnce;
    yield* Effect.promise(() => Bun.sleep(0));
    yield* engine.drain;
  });

export { CHAT_GUID, inbound, makeEngineFixture, makeMigratedEngineFixture, settle };
export type { EngineFixture } from './engine-fixture-types';
export type { TurnBehavior } from './fake-codex-runtime';
