import { Effect, Result } from 'effect';

import type { CodexThreadId, CodexTurnId, LogicalTurnId } from '../domain/ids';
import type { SchedulerControllerError, SchedulerPorts } from '../scheduler/controller';
import type { PooledMessage, SchedulerState, TurnIdentity } from '../scheduler/model';
import { controlReplyText, report, type EngineContext } from './context';
import { startMonitor } from './monitor';
import { failTurn } from './turn-failure';
import { ensureThread, loadPersistedBatch, submit } from './turn-submission';

const cleanupGeneration = (
  context: EngineContext,
  previous: SchedulerState,
): Effect.Effect<void, SchedulerControllerError> => {
  const threadId = previous.codexThreadId;
  if (threadId === null) {
    return Effect.void;
  }
  const turnId = previous.active?.codexTurnId ?? null;
  return Effect.gen(function* cleanupOldGeneration() {
    if (turnId !== null) {
      yield* context.options.runtime.interruptTurn(threadId, turnId);
    }
    yield* context.options.runtime.archiveThread(threadId);
  });
};

const dispatchPoolTimer = Effect.fn('SpikeEngine.dispatchPoolTimer')(function* dispatchPoolTimer(
  context: EngineContext,
  deadlineAt: Date,
  identity: TurnIdentity | null,
) {
  const controller = yield* Effect.promise(() => context.controllerReady.promise);
  const dispatched = yield* Effect.result(controller.dispatch({ deadlineAt, kind: 'PoolTimer' }));
  if (Result.isFailure(dispatched)) {
    if (identity === null) {
      report(context, dispatched.failure);
    } else {
      yield* failTurn(context, identity, dispatched.failure);
    }
  }
});

const schedulePool = (
  context: EngineContext,
  deadlineAt: Date,
  identity: TurnIdentity | null,
): void => {
  const delay = Math.max(0, deadlineAt.getTime() - context.now().getTime());
  const timer = setTimeout(() => {
    context.timers.delete(timer);
    const gatedDispatch = context.options.conversation.awaitAvailable.pipe(
      Effect.andThen(dispatchPoolTimer(context, deadlineAt, identity)),
    );
    Effect.runFork(gatedDispatch);
  }, delay);
  context.timers.add(timer);
};

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
  cleanupGeneration: (previous): Effect.Effect<void, SchedulerControllerError> =>
    cleanupGeneration(context, previous),
  replyLocal: (kind, _state, commandMessageId): Effect.Effect<void, SchedulerControllerError> =>
    replyLocal(context, kind, commandMessageId),
  reportFailure: (error): Effect.Effect<void> =>
    Effect.sync(() => {
      report(context, error);
    }),
  schedulePool: (deadlineAt, identity): Effect.Effect<void> =>
    Effect.sync(() => {
      schedulePool(context, deadlineAt, identity);
    }),
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
