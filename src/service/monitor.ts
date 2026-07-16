import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import type { ClassifiedOutput } from '../codex/output-classifier';
import type { TurnEventHandlers } from '../codex/runtime-types';
import { recoverTurn } from '../codex/turn-recovery';
import {
  type CodexThreadId,
  type CodexTurnId,
  type LogicalTurnId,
  LogicalTurnId as LogicalTurnIdSchema,
} from '../domain/ids';
import { CodexRuntimeError } from '../errors';
import { dispatch, report, type EngineContext } from './context';
import { finishFailedTurn } from './turn-failure';

const acknowledgementEffect = (
  context: EngineContext,
  logicalTurnId: LogicalTurnId,
  turnId: CodexTurnId,
  text: string,
): Effect.Effect<void, unknown> => {
  const delivered = context.options.delivery.deliverAssistantMessage(
    logicalTurnId,
    turnId,
    'WorkAck',
    text,
    context.now(),
  );
  const recorded = Effect.promise(() =>
    dispatch(context, { at: context.now(), kind: 'AcknowledgementEmitted', logicalTurnId }),
  );
  return delivered.pipe(Effect.andThen(recorded));
};

const compactionNoticeEffect = (
  context: EngineContext,
  itemId: string,
): Effect.Effect<void, unknown> =>
  context.options.delivery.deliverControlMessage(
    `compaction:${itemId}`,
    'compacting...',
    context.now(),
  );

const resolvedOutput = (
  context: EngineContext,
  threadId: CodexThreadId,
  turnId: CodexTurnId,
  handlers: TurnEventHandlers,
  reconcile: boolean,
): Effect.Effect<ClassifiedOutput, unknown> =>
  Effect.gen(function* resolveTurnOutput() {
    if (!reconcile) {
      return yield* context.options.runtime.waitForTurn(threadId, turnId, handlers);
    }
    const snapshot = yield* context.options.runtime.readThread(threadId);
    const recovered = recoverTurn(snapshot, turnId);
    if (recovered.kind === 'Failed' || recovered.kind === 'Missing') {
      const message =
        recovered.kind === 'Missing'
          ? 'Codex turn is missing; send /new to start a clean thread.'
          : recovered.message;
      return yield* new CodexRuntimeError({ cause: recovered, message, operation: 'turn/recover' });
    }
    if (recovered.kind === 'Completed') {
      return recovered.output;
    }
    return yield* context.options.runtime.waitForTurn(threadId, turnId, handlers);
  });

const requireFinalAnswer = (
  output: ClassifiedOutput,
  turnId: CodexTurnId,
): Effect.Effect<string, CodexRuntimeError> =>
  output.finalAnswer === null
    ? Effect.fail(
        new CodexRuntimeError({
          cause: turnId,
          message: 'Codex completed without a final answer',
          operation: 'turn/output',
        }),
      )
    : Effect.succeed(output.finalAnswer);

interface TurnNoticeTracker {
  readonly acknowledgementSeen: () => boolean;
  readonly handlers: TurnEventHandlers;
  readonly wait: () => Promise<void>;
}

const chainNotice = async (
  previous: Promise<void>,
  effect: Effect.Effect<void, unknown>,
): Promise<void> => {
  await previous;
  await Effect.runPromise(effect);
};

const makeTurnNoticeTracker = (
  context: EngineContext,
  logicalTurnId: LogicalTurnId,
  turnId: CodexTurnId,
): TurnNoticeTracker => {
  let pending = Promise.resolve();
  let acknowledgementSeen = false;
  const enqueue = (effect: Effect.Effect<void, unknown>): void => {
    pending = chainNotice(pending, effect);
  };
  return {
    acknowledgementSeen: (): boolean => acknowledgementSeen,
    handlers: {
      onAcknowledgement: (text): void => {
        acknowledgementSeen = true;
        enqueue(acknowledgementEffect(context, logicalTurnId, turnId, text));
      },
      onCompactionStarted: (itemId): void => {
        enqueue(compactionNoticeEffect(context, itemId));
      },
    },
    wait: (): Promise<void> => pending,
  };
};

const deliverTurnOutput = (
  context: EngineContext,
  logicalTurnId: LogicalTurnId,
  threadId: CodexThreadId,
  turnId: CodexTurnId,
  reconcile: boolean,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* deliverOutput() {
    const notices = makeTurnNoticeTracker(context, logicalTurnId, turnId);
    const output = yield* resolvedOutput(context, threadId, turnId, notices.handlers, reconcile);
    if (!notices.acknowledgementSeen() && output.acknowledgement !== null) {
      notices.handlers.onAcknowledgement(output.acknowledgement);
    }
    yield* Effect.promise(notices.wait);
    const finalAnswer = yield* requireFinalAnswer(output, turnId);
    yield* context.options.delivery.deliverAssistantMessage(
      logicalTurnId,
      turnId,
      'Final',
      finalAnswer,
      context.now(),
    );
    yield* context.codexJournal.finishLogicalTurn(logicalTurnId, 'Completed', context.now());
    yield* Effect.promise(() =>
      dispatch(context, {
        at: context.now(),
        kind: 'TurnCompleted',
        logicalTurnId,
        nextLogicalTurnId: LogicalTurnIdSchema.make(randomUUID()),
      }),
    );
  });

const runMonitor = async (
  context: EngineContext,
  logicalTurnId: LogicalTurnId,
  threadId: CodexThreadId,
  turnId: CodexTurnId,
  reconcile: boolean,
): Promise<void> => {
  try {
    await Effect.runPromise(deliverTurnOutput(context, logicalTurnId, threadId, turnId, reconcile));
  } catch (error) {
    if (!context.closing.value) {
      try {
        await finishFailedTurn(context, logicalTurnId, turnId, error);
      } catch (deliveryError) {
        report(context, deliveryError);
      }
    }
  } finally {
    context.monitors.delete(turnId);
  }
};

const startMonitor = (
  context: EngineContext,
  logicalTurnId: LogicalTurnId,
  threadId: CodexThreadId,
  turnId: CodexTurnId,
  reconcile = false,
): void => {
  if (context.monitors.has(turnId)) {
    return;
  }
  const task = runMonitor(context, logicalTurnId, threadId, turnId, reconcile);
  context.monitors.set(turnId, task);
};

export { startMonitor };
