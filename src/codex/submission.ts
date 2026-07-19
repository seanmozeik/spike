import { Effect, Result } from 'effect';

import type { StagedImageAttachment } from '../attachments/model';
import {
  AccountId,
  CodexTurnId,
  type CodexThreadId,
  type InputBatchId,
  type LogicalTurnId,
} from '../domain/ids';
import {
  CodexRuntimeError,
  GenerationBroken,
  type JournalTransactionError,
  type WaitingForAuthentication,
  type WaitingForCapacity,
} from '../errors';
import type { CodexAttemptRecord, CodexJournal } from '../journal/codex-journal';
import { classifyCodexAvailability } from './availability';
import { canonicalInputFingerprint, captureFrontier, reconcileSubmission } from './reconcile';
import type { CodexRuntime } from './runtime';

interface CodexInput {
  readonly attachments: readonly StagedImageAttachment[];
  readonly batchId: InputBatchId;
  readonly expectedTurnId?: CodexTurnId;
  readonly input: string;
  readonly kind: 'Start' | 'Steer';
  readonly logicalTurnId: LogicalTurnId;
  readonly threadId: CodexThreadId;
}

interface SubmitCodexInput extends CodexInput {
  readonly frontier: 'Empty' | 'Read';
}

type SubmissionError =
  | CodexRuntimeError
  | GenerationBroken
  | JournalTransactionError
  | WaitingForAuthentication
  | WaitingForCapacity;

const inputFingerprint = (input: CodexInput): string =>
  canonicalInputFingerprint(
    input.input,
    input.attachments.map(({ contentHash }) => contentHash),
  );

const verifyRetryInput = (
  attempt: CodexAttemptRecord,
  input: CodexInput,
): Effect.Effect<void, GenerationBroken> =>
  attempt.batchId === input.batchId &&
  attempt.logicalTurnId === input.logicalTurnId &&
  attempt.submissionKind === input.kind &&
  attempt.inputFingerprint === inputFingerprint(input)
    ? Effect.void
    : Effect.fail(
        new GenerationBroken({ message: 'persisted Codex input changed before retry; send /new' }),
      );

const sendInput = (
  runtime: CodexRuntime,
  input: CodexInput,
  clientUserMessageId: string,
): Effect.Effect<CodexTurnId, CodexRuntimeError> => {
  if (input.kind === 'Start') {
    return runtime.startTurn({
      attachments: input.attachments,
      clientUserMessageId,
      input: input.input,
      threadId: input.threadId,
    });
  }
  if (input.expectedTurnId === undefined) {
    return Effect.die(new Error('steer submission requires expectedTurnId'));
  }
  return runtime
    .steerTurn({
      attachments: input.attachments,
      clientUserMessageId,
      expectedTurnId: input.expectedTurnId,
      input: input.input,
      threadId: input.threadId,
    })
    .pipe(Effect.as(input.expectedTurnId));
};

const acceptTurn = (
  journal: CodexJournal,
  attemptId: Parameters<CodexJournal['acceptCodexTurn']>[0],
  threadId: CodexThreadId,
  turnId: CodexTurnId,
): Effect.Effect<CodexTurnId, JournalTransactionError> =>
  journal.acceptCodexTurn(attemptId, threadId, turnId).pipe(Effect.as(turnId));

const submitCodexInput = Effect.fn('SpikeCodex.submit')(function* submitCodexInput(
  runtime: CodexRuntime,
  journal: CodexJournal,
  input: SubmitCodexInput,
) {
  const before =
    input.frontier === 'Empty'
      ? { id: input.threadId, turns: [] }
      : yield* runtime.readThread(input.threadId);
  const frontier = captureFrontier(before);
  const attemptId = yield* journal.beginCodexAttempt({
    accountId: AccountId.make(runtime.accountId),
    batchId: input.batchId,
    fingerprint: inputFingerprint(input),
    frontier,
    logicalTurnId: input.logicalTurnId,
    startedAt: new Date(),
    submissionKind: input.kind,
  });
  const first = yield* sendInput(runtime, input, attemptId).pipe(Effect.result);
  if (Result.isSuccess(first)) {
    return yield* acceptTurn(journal, attemptId, input.threadId, first.success);
  }
  const availability = classifyCodexAvailability(first.failure);
  if (!(availability instanceof CodexRuntimeError)) {
    return yield* availability;
  }
  yield* journal.recordSubmissionUnknown(attemptId);
  const after = yield* runtime.readThread(input.threadId);
  const reconciliation = reconcileSubmission(frontier, after, attemptId);
  if (reconciliation.kind === 'Resume') {
    return yield* acceptTurn(
      journal,
      attemptId,
      input.threadId,
      CodexTurnId.make(reconciliation.turnId),
    );
  }
  if (reconciliation.kind === 'BreakGeneration') {
    return yield* reconciliation.error;
  }
  const retried = yield* sendInput(runtime, input, attemptId);
  return yield* acceptTurn(journal, attemptId, input.threadId, retried);
});

const recoverCodexInput = Effect.fn('SpikeCodex.recover')(function* recoverCodexInput(
  runtime: CodexRuntime,
  journal: CodexJournal,
  attempt: CodexAttemptRecord,
  input: CodexInput,
) {
  if (attempt.state === 'Accepted') {
    if (attempt.turnId !== null) {
      return CodexTurnId.make(attempt.turnId);
    }
    if (
      attempt.submissionKind === 'Steer' &&
      input.kind === 'Steer' &&
      input.expectedTurnId !== undefined
    ) {
      return input.expectedTurnId;
    }
  }
  const current = yield* runtime.readThread(input.threadId);
  const reconciliation = reconcileSubmission(attempt.frontier, current, attempt.id);
  if (reconciliation.kind === 'BreakGeneration') {
    return yield* reconciliation.error;
  }
  if (reconciliation.kind === 'Resume') {
    return yield* acceptTurn(
      journal,
      attempt.id,
      input.threadId,
      CodexTurnId.make(reconciliation.turnId),
    );
  }
  yield* verifyRetryInput(attempt, input);
  yield* journal.reassignCodexAttempt(attempt.id, AccountId.make(runtime.accountId));
  const retried = yield* sendInput(runtime, input, attempt.id);
  return yield* acceptTurn(journal, attempt.id, input.threadId, retried);
});

export { recoverCodexInput, submitCodexInput };
export type { CodexInput, SubmissionError, SubmitCodexInput };
