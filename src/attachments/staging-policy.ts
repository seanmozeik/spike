import { Duration, Effect, Result } from 'effect';

import type { JournalTransactionError } from '../errors';
import type { OutageDiagnostic } from '../journal/outage-diagnostic';
import { AttachmentStagingPermissionError } from './errors';

interface AttachmentStagingPolicy {
  readonly stageIfDue: (at: Date) => Effect.Effect<boolean, JournalTransactionError>;
}

interface AttachmentStagingPolicyOptions {
  readonly diagnostic: OutageDiagnostic;
  readonly retryIntervalMs?: number;
  readonly stage: Effect.Effect<number, AttachmentStagingPermissionError | JournalTransactionError>;
}

type AttachmentStagingState =
  | { readonly kind: 'Available' }
  | { readonly kind: 'Blocked'; readonly nextAttemptAt: number };

const DEFAULT_RETRY_INTERVAL_MS = Duration.toMillis('5 minutes');

const makeAttachmentStagingPolicy = (
  options: AttachmentStagingPolicyOptions,
): AttachmentStagingPolicy => {
  const retryInterval = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  let state: AttachmentStagingState = { kind: 'Available' };
  const stageIfDue = Effect.fn('AttachmentStagingPolicy.stageIfDue')(function* stageAttachments(
    at: Date,
  ) {
    if (state.kind === 'Blocked' && at.getTime() < state.nextAttemptAt) {
      return false;
    }
    const staged = yield* Effect.result(options.stage);
    if (Result.isSuccess(staged)) {
      yield* options.diagnostic.resolve(at);
      state = { kind: 'Available' };
      return true;
    }
    if (!(staged.failure instanceof AttachmentStagingPermissionError)) {
      return yield* staged.failure;
    }
    yield* options.diagnostic.open(at);
    state = { kind: 'Blocked', nextAttemptAt: at.getTime() + retryInterval };
    return false;
  });
  return { stageIfDue };
};

export { makeAttachmentStagingPolicy };
export type { AttachmentStagingPolicy, AttachmentStagingPolicyOptions };
