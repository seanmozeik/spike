import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';

import type { ThreadSnapshot } from '../src/codex/reconcile';
import type { CodexRuntime } from '../src/codex/runtime-types';
import type { CodexServerRequest } from '../src/codex/server-request-registry';
import { makeConversationPolicy, type ConversationPolicy } from '../src/conversation-policy';
import { openJournal, type JournalHandle } from '../src/database';
import { makeDeliveryJournal } from '../src/delivery/journal';
import { withConversationAvailability } from '../src/delivery/messages-transport';
import { makeDeliveryService } from '../src/delivery/service';
import { ChatGuid, CodexTurnId, MessageGuid, MessagesRowId } from '../src/domain/ids';
import type { ObservedMessage } from '../src/domain/inbound';
import { makeConversationDiagnostic } from '../src/journal/conversation-diagnostic';
import type { LikeAcknowledgement } from '../src/like/adapter';
import { makeFailureLog } from '../src/logging/failure-log';
import { makeSpikeEngine, type SpikeEngine } from '../src/service/engine';
import { prepareAttachmentOptions } from './engine-attachment-fixture';
import { makeInbox } from './engine-inbox-fixture';
import type { RuntimeTrace, TurnBehavior } from './fake-codex-runtime';
import {
  type CountLatch,
  type DeliveryReceipt,
  makeCountLatch,
  makeRuntime,
  makeTransport,
} from './schedule-engine-runtime-fixture';

const CHAT_GUID = ChatGuid.make('any;-;+15555550199');
const HANDLE = '+15555550199';
const START = new Date('2026-07-19T12:00:00.000Z');

interface OpenEngineOptions {
  readonly behavior?: TurnBehavior;
  readonly probe?: () => Effect.Effect<void, unknown>;
  readonly snapshot?: ThreadSnapshot;
  readonly validationIntervalMs?: number;
}

interface OpenedEngine {
  readonly awaitInboxScans: (count: number) => Effect.Effect<void>;
  readonly awaitTurnsCompleted: (count: number) => Effect.Effect<void>;
  readonly awaitTurnsStarted: (count: number) => Effect.Effect<void>;
  readonly close: Effect.Effect<void, unknown>;
  readonly conversation: ConversationPolicy;
  readonly database: Database;
  readonly engine: SpikeEngine;
  readonly handle: JournalHandle;
  readonly inboxScans: () => number;
  readonly publish: (request: CodexServerRequest) => void;
  readonly trace: RuntimeTrace;
}

interface ScheduleEngineHome {
  readonly advanceTo: (instant: string) => void;
  readonly awaitSent: (count: number) => Effect.Effect<void>;
  readonly databasePath: string;
  readonly now: () => Date;
  readonly open: (options?: OpenEngineOptions) => Effect.Effect<OpenedEngine, unknown>;
  readonly push: (text: string) => void;
  readonly remove: () => void;
  readonly sent: readonly string[];
}

const makeLike = (): LikeAcknowledgement => ({
  acknowledge: (): Effect.Effect<void> => Effect.void,
  status: Effect.succeed({
    available: true,
    degraded: false,
    lastFailureAt: null,
    lastFailureReason: null,
    lastSuccessAt: null,
  }),
});

interface ScheduleHomeState {
  current: Date;
  readonly databasePath: string;
  messageSequence: number;
  readonly queue: ObservedMessage[];
  readonly receipts: DeliveryReceipt[];
  readonly root: string;
  readonly sent: string[];
  readonly sentLatch: CountLatch;
  turnSequence: number;
}

interface InboxScanTracker {
  readonly awaitScans: (count: number) => Effect.Effect<void>;
  readonly inbox: ReturnType<typeof makeInbox>;
  readonly read: () => number;
}

const makeInboxScanTracker = (queue: ObservedMessage[]): InboxScanTracker => {
  let scans = 0;
  const latch = makeCountLatch(() => scans);
  return {
    awaitScans: latch.wait,
    inbox: makeInbox(queue, undefined, {
      failuresRemaining: 0,
      onScan: (): Effect.Effect<void> =>
        Effect.sync(() => {
          scans += 1;
          latch.notify();
        }),
      scans: 0,
    }),
    read: (): number => scans,
  };
};

const nextTurnId = (state: ScheduleHomeState): CodexTurnId => {
  state.turnSequence += 1;
  return CodexTurnId.make(`integration-turn-${String(state.turnSequence)}`);
};

const makeIntegrationEngine = (
  state: ScheduleHomeState,
  handle: JournalHandle,
  conversation: ConversationPolicy,
  runtime: CodexRuntime,
  scans: InboxScanTracker,
): ReturnType<typeof makeSpikeEngine> => {
  const now = (): Date => state.current;
  const delivery = makeDeliveryService(
    makeDeliveryJournal(handle.database),
    withConversationAvailability(
      makeTransport(state.sent, state.receipts, state.sentLatch.notify),
      conversation,
    ),
  );
  return makeSpikeEngine({
    ...prepareAttachmentOptions(state.root),
    chatGuid: CHAT_GUID,
    conversation,
    database: handle.database,
    delivery,
    failureLog: makeFailureLog({ write: (): void => undefined }),
    handle: HANDLE,
    inbox: scans.inbox,
    like: makeLike(),
    now,
    phaseRetryMs: 10,
    reconcileIntervalMs: 10,
    renderStatus: () => Promise.resolve('integration status'),
    runtime,
  });
};

const publishRequest = (trace: RuntimeTrace, request: CodexServerRequest): void => {
  for (const listener of trace.requestListeners) {
    listener(request);
  }
};

const openScheduleEngine = Effect.fn('Test.openScheduleEngine')(function* openEngine(
  state: ScheduleHomeState,
  options: OpenEngineOptions,
) {
  const scans = makeInboxScanTracker(state.queue);
  const handle = yield* openJournal(state.databasePath);
  const { awaitTurnsCompleted, awaitTurnsStarted, runtime, trace } = makeRuntime(
    options.behavior ?? {},
    options.snapshot ?? { id: 'thread-new', turns: [] },
    () => nextTurnId(state),
  );
  const conversation = yield* makeConversationPolicy({
    diagnostic: makeConversationDiagnostic(handle.database),
    initialValidationAt: state.current,
    probe: options.probe ?? ((): Effect.Effect<void> => Effect.void),
    ...(options.validationIntervalMs === undefined
      ? {}
      : { validationIntervalMs: options.validationIntervalMs }),
  });
  const engine = yield* makeIntegrationEngine(state, handle, conversation, runtime, scans);
  return {
    awaitInboxScans: scans.awaitScans,
    awaitTurnsCompleted,
    awaitTurnsStarted,
    close: engine.shutdown.pipe(Effect.andThen(Effect.sync(handle.close))),
    conversation,
    database: handle.database,
    engine,
    handle,
    inboxScans: scans.read,
    publish: (request): void => {
      publishRequest(trace, request);
    },
    trace,
  } satisfies OpenedEngine;
});

const pushMessage = (state: ScheduleHomeState, text: string): void => {
  state.messageSequence += 1;
  state.queue.push({
    attachments: [],
    chatGuid: CHAT_GUID,
    handle: HANDLE,
    isFromMe: false,
    messageGuid: MessageGuid.make(`integration-message-${String(state.messageSequence)}`),
    rowId: MessagesRowId.make(state.messageSequence),
    sentAt: state.current,
    service: 'iMessage',
    text,
  });
};

const makeScheduleEngineHome = (): ScheduleEngineHome => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-schedule-engine-'));
  const sent: string[] = [];
  const state: ScheduleHomeState = {
    current: START,
    databasePath: path.join(root, 'spike.db'),
    messageSequence: 0,
    queue: [],
    receipts: [],
    root,
    sent,
    sentLatch: makeCountLatch(() => sent.length),
    turnSequence: 0,
  };
  return {
    advanceTo: (instant): void => {
      state.current = new Date(instant);
    },
    awaitSent: state.sentLatch.wait,
    databasePath: state.databasePath,
    now: (): Date => state.current,
    open: (options = {}): Effect.Effect<OpenedEngine, unknown> =>
      openScheduleEngine(state, options),
    push: (text): void => {
      pushMessage(state, text);
    },
    remove: (): void => {
      rmSync(root, { force: true, recursive: true });
    },
    sent,
  };
};

export { makeScheduleEngineHome, START };
export type { OpenedEngine, ScheduleEngineHome };
