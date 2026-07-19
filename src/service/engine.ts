import { Duration, Effect, Fiber, Result } from 'effect';

import { observeAccount } from '../codex/account-observation';
import { WaitingForCapacity } from '../errors';
import { makeCodexJournal } from '../journal/codex-journal';
import type { PendingControl } from '../journal/control-recovery';
import { makeSchedulerJournal } from '../journal/scheduler-journal';
import { makeJournal } from '../journal/service';
import { makeSchedulerController, type SchedulerController } from '../scheduler/controller';
import type { SchedulerState } from '../scheduler/model';
import { captureAccountFailure, requestPendingAccountFailover } from './account-failover';
import {
  controlReplyText,
  report,
  type AccountFailure,
  type EngineContext,
  type SpikeEngineOptions,
} from './context';
import { initializeConversation } from './conversation-lifecycle';
import { dispatchPending } from './inbound-dispatch';
import { pollInbox } from './inbox-poll';
import { failTurn, retryTurnTerminals } from './turn-failure';
import { recoverActive } from './turn-recovery';
import { makeTurnTerminalQueue } from './turn-terminal-model';
import { makePorts } from './turns';

interface SpikeEngine {
  readonly accountUnavailable: Effect.Effect<AccountFailure>;
  readonly close: () => void;
  readonly drain: Effect.Effect<void>;
  readonly pollOnce: Effect.Effect<void, unknown>;
  readonly quiesce: () => void;
  readonly redactNow: (now: Date) => Effect.Effect<number, unknown>;
  readonly run: Effect.Effect<never>;
  readonly shutdown: Effect.Effect<void, unknown>;
  readonly snapshot: Effect.Effect<SchedulerState>;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const RETENTION_DAYS = 30;
const MILLISECONDS_PER_DAY = 86_400_000;
const REDACTION_INTERVAL_MS = Duration.toMillis('6 hours');
const ACCOUNT_OBSERVATION_INTERVAL_MS = Duration.toMillis('1 minute');

const observeAccountIfDue = Effect.fn('SpikeEngine.observeAccountIfDue')(
  function* observeAccountIfDue(context: EngineContext, controller: SchedulerController) {
    const at = context.now();
    if (
      context.options.runtime.accountId.startsWith('provider:') ||
      context.accountFailover.pending !== null ||
      at.getTime() - context.lastAccountObservationAt.value.getTime() <
        ACCOUNT_OBSERVATION_INTERVAL_MS
    ) {
      return false;
    }
    context.lastAccountObservationAt.value = at;
    const result = yield* Effect.result(
      observeAccount(context.options.runtime, context.codexJournal, at),
    );
    if (Result.isFailure(result)) {
      report(context, result.failure);
      return false;
    }
    if (result.success.mode === 'Capacity') {
      context.accountFailover.pending = new WaitingForCapacity({ resetAt: result.success.resetAt });
      return yield* requestPendingAccountFailover(context, controller);
    }
    return false;
  },
);

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

const recoverPendingTurn = Effect.fn('SpikeEngine.recoverPendingTurn')(function* recoverPendingTurn(
  context: EngineContext,
  controller: SchedulerController,
) {
  if (!context.recoveryPending.value) {
    return false;
  }
  context.recoveryPending.value = false;
  const state = yield* controller.snapshot;
  const recovery = yield* Effect.result(recoverActive(context, controller));
  if (Result.isSuccess(recovery)) {
    return false;
  }
  if (state.active === null) {
    report(context, recovery.failure);
    return false;
  }
  if (yield* captureAccountFailure(context, controller, recovery.failure)) {
    return true;
  }
  yield* failTurn(
    context,
    { generationId: state.generationId, logicalTurnId: state.active.logicalTurnId },
    recovery.failure,
  );
  return false;
});

const pollOnce = (
  context: EngineContext,
  controller: SchedulerController,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* pollMessages() {
    if (!(yield* context.options.conversation.revalidateIfDue(context.now()))) {
      return;
    }
    yield* initializeConversation(context);
    yield* retryTurnTerminals(context);
    if (yield* recoverPendingTurn(context, controller)) {
      return;
    }
    yield* controller.activate;
    yield* recoverControlReplies(context);
    yield* pollInbox(context);
    if (context.approval !== null) {
      yield* context.approval.poll;
    }
    if (yield* requestPendingAccountFailover(context, controller)) {
      return;
    }
    const at = context.now();
    const pending = yield* context.journal.listPendingInbound;
    yield* dispatchPending(context, controller, pending, at);
  });

const beginQuiesce = (context: EngineContext): readonly Fiber.Fiber<void, unknown>[] => {
  context.schedulingClosed.value = true;
  context.options.conversation.close();
  return [...context.scheduledFibers];
};

const quiesceEngine = (context: EngineContext): void => {
  for (const fiber of beginQuiesce(context)) {
    fiber.interruptUnsafe();
  }
};

const closeEngine = (context: EngineContext): void => {
  context.closing.value = true;
  quiesceEngine(context);
};

const makeContext = (options: SpikeEngineOptions, now: () => Date): EngineContext => ({
  accountFailover: { pending: null, requested: false, signal: Promise.withResolvers() },
  approval: null,
  closing: { value: false },
  codexJournal: makeCodexJournal(options.database),
  controllerReady: Promise.withResolvers<SchedulerController>(),
  conversationReady: { value: false },
  journal: makeJournal(options.database, { chatGuid: options.chatGuid, handle: options.handle }),
  lastAccountObservationAt: { value: new Date(0) },
  lastRedactionAt: { value: now() },
  monitors: new Map(),
  now,
  options,
  recoveryPending: { value: true },
  scheduledFibers: new Set(),
  schedulerJournal: makeSchedulerJournal(options.database),
  schedulingClosed: { value: false },
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
  const startupAvailable = yield* options.conversation.revalidate(now(), 'Startup');
  const initial = yield* context.schedulerJournal.loadOrCreate(now());
  if (startupAvailable) {
    yield* initializeConversation(context);
  }
  const controller = yield* makeSchedulerController(
    initial,
    context.schedulerJournal,
    makePorts(context),
  );
  context.controllerReady.resolve(controller);
  const once = observeAccountIfDue(context, controller).pipe(
    Effect.flatMap((rotating) =>
      rotating ? Effect.void : withPeriodicRedaction(context, pollOnce(context, controller)),
    ),
  );
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const cycle = makeCycle(context, once, interval);
  return {
    accountUnavailable: Effect.promise(() => context.accountFailover.signal.promise),
    close: (): void => {
      closeEngine(context);
    },
    drain: Effect.promise(async () => {
      await Promise.all(context.monitors.values());
      await context.turnTerminals.tail;
    }),
    pollOnce: once,
    quiesce: (): void => {
      quiesceEngine(context);
    },
    redactNow: (at): Effect.Effect<number, unknown> => redactNow(context, at),
    run: Effect.forever(cycle),
    shutdown: Effect.gen(function* shutdownEngine() {
      context.closing.value = true;
      const scheduled = beginQuiesce(context);
      yield* Fiber.interruptAll(scheduled);
      context.scheduledFibers.clear();
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
