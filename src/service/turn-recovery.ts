import { Effect } from 'effect';

import { recoverCodexInput } from '../codex/submission';
import type { CodexThreadId, CodexTurnId } from '../domain/ids';
import { GenerationBroken } from '../errors';
import type { PersistedInputBatch } from '../journal/scheduler-recovery';
import type { SchedulerController, SchedulerControllerError } from '../scheduler/controller';
import type { SchedulerState } from '../scheduler/model';
import { inputText, type EngineContext } from './context';
import { startMonitor } from './monitor';
import { findAttempt, submit } from './turn-submission';

const requireInitialBatch = (
  batches: readonly PersistedInputBatch[],
): Effect.Effect<PersistedInputBatch, GenerationBroken> => {
  const [batch] = batches;
  return batch === undefined
    ? Effect.fail(
        new GenerationBroken({ message: 'persisted initial input batch is missing; send /new' }),
      )
    : Effect.succeed(batch);
};

const recoverPendingSteers = (
  context: EngineContext,
  state: SchedulerState & { readonly active: NonNullable<SchedulerState['active']> },
  threadId: CodexThreadId,
  turnId: CodexTurnId,
): Effect.Effect<void, SchedulerControllerError> =>
  Effect.gen(function* recoverSteers() {
    const batches = yield* context.schedulerJournal.loadInputBatches(
      state.active.logicalTurnId,
      'Steer',
    );
    const attempts = yield* context.codexJournal.loadNonterminalAttempts;
    const hasUnidentifiedAttempt = attempts.some(
      (attempt) =>
        attempt.batchId === null &&
        attempt.logicalTurnId === state.active.logicalTurnId &&
        attempt.submissionKind === 'Steer',
    );
    yield* hasUnidentifiedAttempt
      ? Effect.fail(
          new GenerationBroken({
            message: 'a legacy steer attempt has no durable input batch identity; send /new',
          }),
        )
      : Effect.void;
    for (const batch of batches) {
      const attempt = findAttempt(attempts, batch);
      const recovery =
        attempt === undefined
          ? submit(context, state, batch, turnId).pipe(Effect.asVoid)
          : recoverCodexInput(context.options.runtime, context.codexJournal, attempt, {
              batchId: batch.id,
              expectedTurnId: turnId,
              input: inputText(batch.messages),
              kind: 'Steer',
              logicalTurnId: batch.logicalTurnId,
              threadId,
            }).pipe(Effect.asVoid);
      yield* recovery;
    }
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
      const batches = yield* context.schedulerJournal.loadInputBatches(
        state.active.logicalTurnId,
        'Initial',
      );
      const batch = yield* requireInitialBatch(batches);
      const started = yield* submit(context, state, batch);
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
    yield* recoverPendingSteers(context, { ...state, active: state.active }, threadId, turnId);
    startMonitor(
      context,
      { generationId: state.generationId, logicalTurnId: state.active.logicalTurnId },
      threadId,
      turnId,
      !submittedNow,
    );
  });

export { recoverActive };
