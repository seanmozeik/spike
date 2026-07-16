import { Effect, Result } from 'effect';

import { recoverCodexInput, submitCodexInput, type CodexInput } from '../codex/submission';
import type { CodexThreadId, CodexTurnId, LogicalTurnId } from '../domain/ids';
import { GenerationBroken, isGenerationBroken } from '../errors';
import type { CodexAttemptRecord } from '../journal/codex-journal';
import type {
  SchedulerController,
  SchedulerControllerError,
  SchedulerPorts,
} from '../scheduler/controller';
import type { PooledMessage, SchedulerState } from '../scheduler/model';
import { controlReplyText, dispatch, inputText, report, type EngineContext } from './context';
import { startMonitor } from './monitor';

interface EnsuredThread {
  readonly threadId: CodexThreadId;
  readonly unused: boolean;
}

const ensureThread = (
  context: EngineContext,
  state: SchedulerState,
): Effect.Effect<EnsuredThread, SchedulerControllerError> =>
  Effect.gen(function* ensureCodexThread() {
    const binding = yield* context.codexJournal.loadGenerationThreadState(state.generationId);
    if (binding === null) {
      const threadId = yield* context.options.runtime.startThread;
      yield* context.codexJournal.bindGenerationThread(state.generationId, threadId);
      return { threadId, unused: true };
    }
    const { threadId: boundThreadId, unused } = binding;
    const loaded = yield* context.options.runtime.loadedThreads;
    if (loaded.includes(boundThreadId)) {
      return { threadId: boundThreadId, unused };
    }
    const resumed = yield* Effect.result(context.options.runtime.resumeThread(boundThreadId));
    if (Result.isSuccess(resumed)) {
      return { threadId: boundThreadId, unused };
    }
    if (!isGenerationBroken(resumed.failure)) {
      return yield* resumed.failure;
    }
    const replacementThreadId = yield* context.options.runtime.startThread;
    const replaced = yield* context.codexJournal.replaceUnusedGenerationThread(
      state.generationId,
      boundThreadId,
      replacementThreadId,
    );
    if (!replaced) {
      return yield* new GenerationBroken({
        message: 'Codex thread has persisted history but its rollout is missing; send /new',
      });
    }
    return { threadId: replacementThreadId, unused: true };
  });

const findAttempt = (
  attempts: readonly CodexAttemptRecord[],
  logicalTurnId: LogicalTurnId,
  kind: 'Start' | 'Steer',
): CodexAttemptRecord | undefined =>
  attempts.findLast(
    (attempt) => attempt.logicalTurnId === logicalTurnId && attempt.submissionKind === kind,
  );

const submit = (
  context: EngineContext,
  state: SchedulerState,
  logicalTurnId: LogicalTurnId,
  messages: readonly PooledMessage[],
  kind: 'Start' | 'Steer',
  expectedTurnId?: CodexTurnId,
): Effect.Effect<
  { readonly threadId: CodexThreadId; readonly turnId: CodexTurnId },
  SchedulerControllerError
> =>
  Effect.gen(function* submitLogicalTurn() {
    const ensured = yield* ensureThread(context, state);
    const { threadId } = ensured;
    const input: CodexInput = {
      ...(expectedTurnId === undefined ? {} : { expectedTurnId }),
      input: inputText(messages),
      kind,
      logicalTurnId,
      threadId,
    };
    const attempts = yield* context.codexJournal.loadNonterminalAttempts;
    const attempt = findAttempt(attempts, logicalTurnId, kind);
    const turnId =
      attempt === undefined
        ? yield* submitCodexInput(context.options.runtime, context.codexJournal, {
            ...input,
            frontier: ensured.unused ? 'Empty' : 'Read',
          })
        : yield* recoverCodexInput(context.options.runtime, context.codexJournal, attempt, input);
    return { threadId, turnId };
  });

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

const schedulePool = (context: EngineContext, deadlineAt: Date): void => {
  const delay = Math.max(0, deadlineAt.getTime() - context.now().getTime());
  const timer = setTimeout(() => {
    context.timers.delete(timer);
    Effect.runFork(Effect.promise(() => dispatch(context, { deadlineAt, kind: 'PoolTimer' })));
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
    const started = yield* submit(
      context,
      yield* controller.snapshot,
      logicalTurnId,
      messages,
      'Start',
    );
    queueMicrotask(() => {
      startMonitor(context, logicalTurnId, started.threadId, started.turnId);
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
  schedulePool: (deadlineAt): Effect.Effect<void> =>
    Effect.sync(() => {
      schedulePool(context, deadlineAt);
    }),
  startTurn: (logicalTurnId, messages): ReturnType<SchedulerPorts['startTurn']> =>
    startTurnPort(context, logicalTurnId, messages),
  steerTurn: (action): Effect.Effect<void, SchedulerControllerError> =>
    Effect.gen(function* steerTurn() {
      const controller = yield* Effect.promise(() => context.controllerReady.promise);
      yield* submit(
        context,
        yield* controller.snapshot,
        action.logicalTurnId,
        action.messages,
        'Steer',
        action.codexTurnId,
      );
    }),
});

const recoverPendingSteer = (
  context: EngineContext,
  state: SchedulerState & { readonly active: NonNullable<SchedulerState['active']> },
  threadId: CodexThreadId,
  turnId: CodexTurnId,
): Effect.Effect<void, SchedulerControllerError> =>
  Effect.gen(function* recoverSteer() {
    const attempts = yield* context.codexJournal.loadNonterminalAttempts;
    const attempt = attempts.findLast(
      (candidate) =>
        candidate.logicalTurnId === state.active.logicalTurnId &&
        candidate.submissionKind === 'Steer' &&
        candidate.state !== 'Accepted',
    );
    if (attempt === undefined) {
      return;
    }
    const messages = yield* context.schedulerJournal.loadLatestBatchMessages(
      state.active.logicalTurnId,
      'Steer',
    );
    yield* recoverCodexInput(context.options.runtime, context.codexJournal, attempt, {
      expectedTurnId: turnId,
      input: inputText(messages),
      kind: 'Steer',
      logicalTurnId: state.active.logicalTurnId,
      threadId,
    });
  });

const recoverActive = (
  context: EngineContext,
  controller: SchedulerController,
): Effect.Effect<void, SchedulerControllerError> =>
  Effect.gen(function* recoverActiveTurn() {
    const state = yield* controller.snapshot;
    if (state.active === null) {
      return;
    }
    let threadId = state.codexThreadId;
    let turnId = state.active.codexTurnId;
    let submittedNow = false;
    if (threadId === null || turnId === null) {
      const messages = yield* context.schedulerJournal.loadLatestBatchMessages(
        state.active.logicalTurnId,
        'Initial',
      );
      const started = yield* submit(context, state, state.active.logicalTurnId, messages, 'Start');
      ({ threadId, turnId } = started);
      submittedNow = true;
      yield* controller.dispatch({
        at: context.now(),
        codexTurnId: turnId,
        kind: 'TurnStarted',
        logicalTurnId: state.active.logicalTurnId,
      });
    }
    const loaded = yield* context.options.runtime.loadedThreads;
    if (!loaded.includes(threadId)) {
      yield* context.options.runtime.resumeThread(threadId);
    }
    startMonitor(context, state.active.logicalTurnId, threadId, turnId, !submittedNow);
    yield* recoverPendingSteer(context, { ...state, active: state.active }, threadId, turnId);
  });

export { makePorts, recoverActive };
