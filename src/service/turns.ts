import { randomUUID } from 'node:crypto';

import { Effect, Fiber, Result } from 'effect';

import {
  GenerationId,
  LogicalTurnId as LogicalTurnIdSchema,
  type CodexThreadId,
  type CodexTurnId,
  type LogicalTurnId,
} from '../domain/ids';
import type { SchedulerControllerError, SchedulerPorts } from '../scheduler/controller';
import type { PooledMessage, SchedulerState, TurnIdentity } from '../scheduler/model';
import { captureAccountFailure } from './account-failover';
import { controlReplyText, report, type EngineContext } from './context';
import { repairDispatchFailure } from './dispatch-repair';
import { startMonitor } from './monitor';
import { ensureThread, loadPersistedBatch, submit } from './turn-submission';

const cleanupGeneration = (
  context: EngineContext,
  previous: SchedulerState,
  kind: 'ResetGeneration' | 'RotateConfiguration',
): Effect.Effect<void, SchedulerControllerError> => {
  const threadId = previous.codexThreadId;
  if (threadId === null) {
    return Effect.void;
  }
  const turnId = previous.active?.codexTurnId ?? null;
  return Effect.gen(function* cleanupOldGeneration() {
    let interruptFailure: SchedulerControllerError | null = null;
    if (kind === 'ResetGeneration' && turnId !== null) {
      const interrupted = yield* Effect.result(
        context.options.runtime.interruptTurn(threadId, turnId),
      );
      if (Result.isFailure(interrupted)) {
        interruptFailure = interrupted.failure;
      }
    }
    const archived = yield* Effect.result(context.options.runtime.archiveThread(threadId));
    if (Result.isFailure(archived)) {
      return yield* archived.failure;
    }
    if (interruptFailure !== null) {
      return yield* interruptFailure;
    }
    return yield* Effect.void;
  });
};

const dispatchPoolTimer = Effect.fn('SpikeEngine.dispatchPoolTimer')(function* dispatchPoolTimer(
  context: EngineContext,
  deadlineAt: Date,
  identity: TurnIdentity | null,
) {
  const controller = yield* Effect.promise(() => context.controllerReady.promise);
  const nextLogicalTurnId = LogicalTurnIdSchema.make(randomUUID());
  const dispatch = controller.dispatch({
    deadlineAt,
    kind: 'PoolTimer',
    newGenerationId: GenerationId.make(randomUUID()),
    nextLogicalTurnId,
  });
  const dispatched = yield* Effect.result(dispatch);
  if (Result.isFailure(dispatched)) {
    if (yield* captureAccountFailure(context, controller, dispatched.failure)) {
      return;
    }
    const state = yield* controller.snapshot;
    yield* repairDispatchFailure(context, state, nextLogicalTurnId, identity, dispatched.failure);
  }
});

const schedulePool = Effect.fn('SpikeEngine.schedulePool')(function* schedulePool(
  context: EngineContext,
  deadlineAt: Date,
  identity: TurnIdentity | null,
) {
  const schedulingClosed = (): boolean => context.schedulingClosed.value;
  if (schedulingClosed()) {
    return;
  }
  const delay = Math.max(0, deadlineAt.getTime() - context.now().getTime());
  const scheduled = Effect.sleep(delay).pipe(
    Effect.andThen(
      Effect.suspend(() =>
        schedulingClosed()
          ? Effect.void
          : context.options.conversation.awaitAvailable.pipe(
              Effect.andThen(dispatchPoolTimer(context, deadlineAt, identity)),
            ),
      ),
    ),
  );
  const fiber = yield* Effect.forkDetach(scheduled, { startImmediately: true });
  if (schedulingClosed()) {
    yield* Fiber.interrupt(fiber);
    return;
  }
  context.scheduledFibers.add(fiber);
  fiber.addObserver(() => {
    context.scheduledFibers.delete(fiber);
  });
});

const replyLocal = (
  context: EngineContext,
  kind: 'NewChat' | 'Status',
  commandMessageId: Parameters<SchedulerPorts['replyLocal']>[2],
): Effect.Effect<void, SchedulerControllerError> =>
  controlReplyText(context, kind).pipe(
    Effect.flatMap((text) =>
      context.options.delivery.deliverControlMessage(commandMessageId, text, context.now()),
    ),
  );

const startTurnPort = (
  context: EngineContext,
  logicalTurnId: LogicalTurnId,
  messages: readonly PooledMessage[],
): Effect.Effect<
  { readonly threadId: CodexThreadId; readonly turnId: CodexTurnId },
  SchedulerControllerError
> =>
  Effect.gen(function* startTurn() {
    const controller = yield* Effect.promise(() => context.controllerReady.promise);
    const state = yield* controller.snapshot;
    const batch = yield* loadPersistedBatch(context, logicalTurnId, 'Initial', messages);
    const started = yield* submit(context, state, batch);
    queueMicrotask(() => {
      startMonitor(
        context,
        { generationId: state.generationId, logicalTurnId },
        started.threadId,
        started.turnId,
      );
    });
    return started;
  });

const makePorts = (context: EngineContext): SchedulerPorts => ({
  bindThread: (): Effect.Effect<CodexThreadId | null, SchedulerControllerError> =>
    Effect.gen(function* bindThread() {
      const controller = yield* Effect.promise(() => context.controllerReady.promise);
      return (yield* ensureThread(context, yield* controller.snapshot)).threadId;
    }),
  cleanupGeneration: (previous, kind): Effect.Effect<void, SchedulerControllerError> =>
    cleanupGeneration(context, previous, kind),
  replyLocal: (kind, _state, commandMessageId): Effect.Effect<void, SchedulerControllerError> =>
    replyLocal(context, kind, commandMessageId),
  reportFailure: (error): Effect.Effect<void> =>
    Effect.sync(() => {
      report(context, error);
    }),
  schedulePool: (deadlineAt, identity): Effect.Effect<void> =>
    schedulePool(context, deadlineAt, identity),
  startTurn: (logicalTurnId, messages): ReturnType<SchedulerPorts['startTurn']> =>
    startTurnPort(context, logicalTurnId, messages),
  steerTurn: (action): Effect.Effect<void, SchedulerControllerError> =>
    Effect.gen(function* steerTurn() {
      const controller = yield* Effect.promise(() => context.controllerReady.promise);
      const batch = yield* loadPersistedBatch(
        context,
        action.logicalTurnId,
        'Steer',
        action.messages,
      );
      yield* submit(context, yield* controller.snapshot, batch, action.codexTurnId);
    }),
});

export { makePorts };
