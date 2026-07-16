import { Effect, Result } from 'effect';

import type { InboundMessageId } from '../domain/ids';
import type { LikeJournal, LikeStatus } from './journal';
import type { LikeNativeRunner } from './native-runner';

interface LikeAcknowledgement {
  readonly acknowledge: (
    inboundMessageId: InboundMessageId,
    text: string,
    acceptedAt: Date,
  ) => Effect.Effect<void>;
  readonly status: Effect.Effect<LikeStatus>;
}

interface FailureReporter {
  readonly report: (error: unknown) => void;
}
const FAILURE_REASON_LIMIT = 240;

const failureReason = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, FAILURE_REASON_LIMIT) : 'Like helper failed';

const makeLikeAcknowledgement = (
  journal: LikeJournal,
  runNative: LikeNativeRunner,
  failureReporter: FailureReporter,
): LikeAcknowledgement => ({
  acknowledge: (inboundMessageId, text, acceptedAt): Effect.Effect<void> =>
    Effect.gen(function* acknowledgeLike() {
      const begun = yield* Effect.result(journal.beginOnce(inboundMessageId, acceptedAt));
      if (Result.isFailure(begun)) {
        failureReporter.report(begun.failure);
        return;
      }
      if (begun.success === null) {
        return;
      }
      const native = yield* Effect.result(runNative(text));
      let succeeded = false;
      let reason: string | null;
      if (Result.isFailure(native)) {
        reason = failureReason(native.failure);
      } else if (native.success.kind === 'liked') {
        succeeded = true;
        reason = null;
      } else {
        reason = native.success.reason ?? native.success.kind;
      }
      const finished = yield* Effect.result(
        journal.finish(begun.success, succeeded ? 'Succeeded' : 'Failed', reason, new Date()),
      );
      if (Result.isFailure(finished)) {
        failureReporter.report(finished.failure);
      }
    }),
  status: journal.status.pipe(
    Effect.match({
      onFailure: (error): LikeStatus => {
        failureReporter.report(error);
        return {
          available: false,
          degraded: true,
          lastFailureAt: new Date(),
          lastFailureReason: 'Like status unavailable',
          lastSuccessAt: null,
        };
      },
      onSuccess: (status) => status,
    }),
  ),
});

const makeDisabledLikeAcknowledgement = (journal: LikeJournal): LikeAcknowledgement => ({
  acknowledge: (): Effect.Effect<void> => Effect.void,
  status: journal.status.pipe(
    Effect.orElseSucceed(() => ({
      available: false,
      degraded: false,
      lastFailureAt: null,
      lastFailureReason: null,
      lastSuccessAt: null,
    })),
  ),
});

export { makeDisabledLikeAcknowledgement, makeLikeAcknowledgement };
export type { FailureReporter, LikeAcknowledgement };
