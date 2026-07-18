import { randomUUID } from 'node:crypto';

import { Duration, Effect, Result } from 'effect';

import { makeApprovalManager } from '../approval/manager';
import { GenerationId, type InboundMessageId, LogicalTurnId } from '../domain/ids';
import { makeCodexJournal } from '../journal/codex-journal';
import type { PendingControl } from '../journal/control-recovery';
import type { PendingInboundMessage } from '../journal/inbound-recovery';
import { makeSchedulerJournal } from '../journal/scheduler-journal';
import { cursorRowId, makeJournal } from '../journal/service';
import { makeSchedulerController, type SchedulerController } from '../scheduler/controller';
import type { SchedulerState } from '../scheduler/model';
import { controlReplyText, report, type EngineContext, type SpikeEngineOptions } from './context';
import { failTurn, retryTurnTerminals } from './turn-failure';
import { recoverActive } from './turn-recovery';
import { makeTurnTerminalQueue } from './turn-terminal-model';
import { makePorts } from './turns';

interface SpikeEngine {
  readonly close: () => void;
  readonly drain: Effect.Effect<void>;
  readonly pollOnce: Effect.Effect<void, unknown>;
  readonly redactNow: (now: Date) => Effect.Effect<number, unknown>;
  readonly run: Effect.Effect<never>;
  readonly shutdown: Effect.Effect<void, unknown>;
  readonly snapshot: Effect.Effect<SchedulerState>;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const RETENTION_DAYS = 30;
const MILLISECONDS_PER_DAY = 86_400_000;
const REDACTION_INTERVAL_MS = Duration.toMillis('6 hours');

const redactAt = Effect.fn('SpikeEngine.redactAt')(function* redactAt(
  context: EngineContext,
  at: Date,
) {
  return yield* context.journal.redactTerminalPayloads(
    new Date(at.getTime() - RETENTION_DAYS * MILLISECONDS_PER_DAY),
    at,
  );
});

const redactNow = Effect.fn('SpikeEngine.redactNow')(function* redactNow(
  context: EngineContext,
  at: Date,
) {
  const count = yield* redactAt(context, at);
  context.lastRedactionAt.value = at;
  return count;
});

const redactIfDue = Effect.fn('SpikeEngine.redactIfDue')(function* redactIfDue(
  context: EngineContext,
) {
  const at = context.now();
  if (at.getTime() - context.lastRedactionAt.value.getTime() < REDACTION_INTERVAL_MS) {
    return;
  }
  const result = yield* Effect.result(redactAt(context, at));
  if (Result.isFailure(result)) {
    report(context, result.failure);
    return;
  }
  context.lastRedactionAt.value = at;
});

const runLike = (context: EngineContext, id: InboundMessageId, text: string, at: Date): void => {
  Effect.runFork(context.options.like.acknowledge(id, text, at));
};

const dispatchPending = (
  context: EngineContext,
  controller: SchedulerController,
  messages: readonly PendingInboundMessage[],
  at: Date,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* dispatchMessages() {
    for (const message of messages) {
      if (message.acknowledgementText !== null) {
        runLike(context, message.id, message.acknowledgementText, at);
      }
      const state = yield* controller.snapshot;
      const nextLogicalTurnId = LogicalTurnId.make(randomUUID());
      const event = {
        kind: 'Inbound',
        message: { id: message.id, receivedAt: message.receivedAt, text: message.text },
        newGenerationId: GenerationId.make(randomUUID()),
        nextLogicalTurnId,
      } as const;
      const dispatched = yield* Effect.result(controller.dispatch(event));
      if (Result.isFailure(dispatched)) {
        const command = message.text.trim().toLowerCase();
        if (
          state.active === null &&
          !state.generationBroken &&
          command !== '/new' &&
          command !== '/status'
        ) {
          yield* failTurn(
            context,
            { generationId: state.generationId, logicalTurnId: nextLogicalTurnId },
            dispatched.failure,
          );
        } else {
          report(context, dispatched.failure);
        }
        return;
      }
    }
  });

const recoverControlReply = (
  context: EngineContext,
  control: PendingControl,
): Effect.Effect<void, unknown> =>
  controlReplyText(context, control.command === '/status' ? 'Status' : 'NewChat').pipe(
    Effect.flatMap((text) =>
      context.options.delivery.deliverControlMessage(control.inboundMessageId, text, context.now()),
    ),
  );

const recoverControlReplies = (context: EngineContext): Effect.Effect<void, unknown> =>
  Effect.gen(function* recoverReplies() {
    const controls = yield* context.journal.listPendingControls;
    for (const control of controls) {
      yield* recoverControlReply(context, control);
    }
  });

const pollOnce = (
  context: EngineContext,
  controller: SchedulerController,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* pollMessages() {
    yield* retryTurnTerminals(context);
    if (context.recoveryPending.value) {
      context.recoveryPending.value = false;
      const state = yield* controller.snapshot;
      const recovery = yield* Effect.result(recoverActive(context, controller));
      if (Result.isFailure(recovery)) {
        if (state.active === null) {
          report(context, recovery.failure);
        } else {
          yield* failTurn(
            context,
            { generationId: state.generationId, logicalTurnId: state.active.logicalTurnId },
            recovery.failure,
          );
        }
      }
    }
    yield* recoverControlReplies(context);
    const cursor = yield* context.journal.inboxCursor(context.options.chatGuid);
    const observed = yield* context.options.inbox.observeAfter(cursorRowId(cursor));
    if (observed.length > 0) {
      yield* context.journal.ingestObservedMessages(
        context.options.chatGuid,
        context.now(),
        observed,
      );
    }
    if (context.approval !== null) {
      yield* context.approval.poll;
    }
    const at = context.now();
    const pending = yield* context.journal.listPendingInbound;
    yield* dispatchPending(context, controller, pending, at);
  });

const closeEngine = (context: EngineContext): void => {
  context.closing.value = true;
  for (const timer of context.timers) {
    clearTimeout(timer);
  }
  context.timers.clear();
};

const seedInboxCursor = (context: EngineContext): Effect.Effect<void, unknown> =>
  Effect.gen(function* seedCursor() {
    const existing = yield* context.journal.inboxCursor(context.options.chatGuid);
    if (existing === null) {
      const frontier = yield* context.options.inbox.frontier;
      yield* context.journal.initializeInboxCursor(
        context.options.chatGuid,
        frontier,
        context.now(),
      );
    }
  });

const makeContext = (options: SpikeEngineOptions, now: () => Date): EngineContext => ({
  approval: null,
  closing: { value: false },
  codexJournal: makeCodexJournal(options.database),
  controllerReady: Promise.withResolvers<SchedulerController>(),
  journal: makeJournal(options.database, { chatGuid: options.chatGuid, handle: options.handle }),
  lastRedactionAt: { value: now() },
  monitors: new Map(),
  now,
  options,
  recoveryPending: { value: true },
  schedulerJournal: makeSchedulerJournal(options.database),
  timers: new Set(),
  turnTerminals: makeTurnTerminalQueue(),
});

const makeCycle = (
  context: EngineContext,
  once: Effect.Effect<void, unknown>,
  interval: number,
): Effect.Effect<void> =>
  Effect.gen(function* cycle() {
    const result = yield* Effect.result(once);
    if (Result.isFailure(result)) {
      report(context, result.failure);
    }
    yield* Effect.promise(() => Bun.sleep(interval));
  });

const withPeriodicRedaction = (
  context: EngineContext,
  once: Effect.Effect<void, unknown>,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* pollAndMaintain() {
    const result = yield* Effect.result(once);
    yield* redactIfDue(context);
    if (Result.isFailure(result)) {
      return yield* Effect.fail(result.failure);
    }
    return yield* Effect.void;
  });

const makeSpikeEngine = Effect.fn('SpikeEngine.make')(function* makeSpikeEngine(
  options: SpikeEngineOptions,
) {
  const now = options.now ?? ((): Date => new Date());
  const context = makeContext(options, now);
  yield* seedInboxCursor(context);
  const initial = yield* context.schedulerJournal.loadOrCreate(now());
  yield* options.delivery.recover;
  context.approval = yield* makeApprovalManager({
    database: options.database,
    delivery: options.delivery,
    ...(options.approvalExpiryMs === undefined ? {} : { expiryMs: options.approvalExpiryMs }),
    now,
    runtime: options.runtime,
  });
  const controller = yield* makeSchedulerController(
    initial,
    context.schedulerJournal,
    makePorts(context),
  );
  context.controllerReady.resolve(controller);
  const once = withPeriodicRedaction(context, pollOnce(context, controller));
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const cycle = makeCycle(context, once, interval);
  return {
    close: (): void => {
      closeEngine(context);
    },
    drain: Effect.promise(async () => {
      await Promise.all(context.monitors.values());
      await context.turnTerminals.tail;
    }),
    pollOnce: once,
    redactNow: (at): Effect.Effect<number, unknown> => redactNow(context, at),
    run: Effect.forever(cycle),
    shutdown: Effect.gen(function* shutdownEngine() {
      closeEngine(context);
      if (context.approval !== null) {
        yield* context.approval.close;
      }
    }),
    snapshot: controller.snapshot,
  } satisfies SpikeEngine;
});

export { makeSpikeEngine };
export type { SpikeEngine };
export type { SpikeEngineOptions } from './context';
