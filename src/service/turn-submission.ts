import { Effect, Result } from 'effect';

import { recoverCodexInput, submitCodexInput, type CodexInput } from '../codex/submission';
import type { CodexTurnId, LogicalTurnId } from '../domain/ids';
import { GenerationBroken, isGenerationBroken } from '../errors';
import type { CodexAttemptRecord } from '../journal/codex-journal';
import type { PersistedInputBatch } from '../journal/scheduler-recovery';
import type { SchedulerControllerError } from '../scheduler/controller';
import { inputBatchFingerprint } from '../scheduler/input-batch';
import type { PooledMessage, SchedulerState } from '../scheduler/model';
import { renderCodexInput } from './codex-input';
import type { EngineContext } from './context';

interface EnsuredThread {
  readonly threadId: CodexInput['threadId'];
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
  batch: PersistedInputBatch,
): CodexAttemptRecord | undefined =>
  attempts.find(
    (attempt) =>
      attempt.batchId === batch.id &&
      attempt.logicalTurnId === batch.logicalTurnId &&
      attempt.submissionKind === (batch.kind === 'Initial' ? 'Start' : 'Steer'),
  );

const loadPersistedBatch = (
  context: EngineContext,
  logicalTurnId: LogicalTurnId,
  kind: 'Initial' | 'Steer',
  messages: readonly PooledMessage[],
): Effect.Effect<PersistedInputBatch, SchedulerControllerError> =>
  Effect.gen(function* loadBatch() {
    const batches = yield* context.schedulerJournal.loadInputBatches(logicalTurnId, kind);
    const fingerprint = inputBatchFingerprint(messages);
    const batch = batches.find((candidate) => candidate.fingerprint === fingerprint);
    if (batch === undefined) {
      return yield* new GenerationBroken({
        message: `persisted ${kind.toLowerCase()} input batch is missing; send /new`,
      });
    }
    return batch;
  });

const submit = (
  context: EngineContext,
  state: SchedulerState,
  batch: PersistedInputBatch,
  expectedTurnId?: CodexTurnId,
): Effect.Effect<
  { readonly threadId: CodexInput['threadId']; readonly turnId: CodexTurnId },
  SchedulerControllerError
> =>
  Effect.gen(function* submitLogicalTurn() {
    const ensured = yield* ensureThread(context, state);
    const { threadId } = ensured;
    const kind = batch.kind === 'Initial' ? 'Start' : 'Steer';
    const input: CodexInput = {
      ...renderCodexInput(batch.messages),
      ...(expectedTurnId === undefined ? {} : { expectedTurnId }),
      batchId: batch.id,
      kind,
      logicalTurnId: batch.logicalTurnId,
      threadId,
    };
    const attempts = yield* context.codexJournal.loadNonterminalAttempts;
    if (
      attempts.some(
        (attempt) =>
          attempt.batchId === null &&
          attempt.logicalTurnId === batch.logicalTurnId &&
          attempt.submissionKind === kind,
      )
    ) {
      return yield* new GenerationBroken({
        message: 'a legacy Codex attempt has no durable input batch identity; send /new',
      });
    }
    const attempt = findAttempt(attempts, batch);
    const turnId =
      attempt === undefined
        ? yield* submitCodexInput(context.options.runtime, context.codexJournal, {
            ...input,
            frontier: ensured.unused ? 'Empty' : 'Read',
          })
        : yield* recoverCodexInput(context.options.runtime, context.codexJournal, attempt, input);
    context.scheduleRequests?.attemptAccepted();
    return { threadId, turnId };
  });

export { ensureThread, findAttempt, loadPersistedBatch, submit };
