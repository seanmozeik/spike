import { Effect, Result } from 'effect';

import { AccountId } from '../domain/ids';
import {
  WaitingForCapacity,
  type CodexRuntimeError,
  type WaitingForAuthentication,
} from '../errors';
import type { CodexJournal } from '../journal/codex-journal';
import { readRateLimits, type RateLimitWindow } from '../status/rate-limits';
import type { AccountAvailabilityMode } from './account-pool';
import type { CodexRuntime } from './runtime';

interface AccountAvailability {
  readonly mode: AccountAvailabilityMode;
  readonly resetAt: Date | null;
}

const resetDate = (window: RateLimitWindow): Date | null => {
  if (window.resetsAt === null) {
    return null;
  }
  const parsed = new Date(window.resetsAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const availabilityFromRateLimits = (value: unknown): AccountAvailability => {
  const limits = readRateLimits(value);
  const exhausted = [limits.fiveHour, limits.weekly].filter(
    (window): window is RateLimitWindow => window !== null && window.remainingPercent <= 0,
  );
  const resetAt =
    exhausted
      .map((window) => resetDate(window))
      .filter((reset): reset is Date => reset !== null)
      .toSorted((left, right) => right.getTime() - left.getTime())[0] ?? null;
  return { mode: exhausted.length === 0 ? 'Available' : 'Capacity', resetAt };
};

const readRuntimeAccount = (
  runtime: CodexRuntime,
): Effect.Effect<{ readonly rateLimits: unknown; readonly usage: unknown }, CodexRuntimeError> =>
  Effect.all(
    {
      rateLimits: runtime.rateLimits,
      usage: runtime.usage.pipe(
        Effect.result,
        Effect.map((result) => (Result.isSuccess(result) ? result.success : null)),
      ),
    },
    { concurrency: 'unbounded' },
  );

const observeAccount = Effect.fn('SpikeAccounts.observe')(function* observeAccount(
  runtime: CodexRuntime,
  journal: CodexJournal,
  observedAt: Date,
) {
  const snapshot = yield* readRuntimeAccount(runtime);
  const availability = availabilityFromRateLimits(snapshot.rateLimits);
  yield* journal.recordAccountObservation(
    AccountId.make(runtime.accountId),
    availability.mode,
    snapshot.usage,
    availability.resetAt,
    observedAt,
  );
  return availability;
});

const recordUnavailableAccount = Effect.fn('SpikeAccounts.recordUnavailable')(
  function* recordUnavailableAccount(
    runtime: CodexRuntime,
    journal: CodexJournal,
    error: WaitingForAuthentication | WaitingForCapacity,
    observedAt: Date,
  ) {
    const snapshot = yield* Effect.result(readRuntimeAccount(runtime));
    const rateAvailability = Result.isSuccess(snapshot)
      ? availabilityFromRateLimits(snapshot.success.rateLimits)
      : { mode: 'Capacity' as const, resetAt: null };
    const capacityFailure = error instanceof WaitingForCapacity;
    const mode = capacityFailure ? 'Capacity' : 'Authentication';
    const resetAt = capacityFailure ? (error.resetAt ?? rateAvailability.resetAt) : null;
    yield* journal.recordAccountObservation(
      AccountId.make(runtime.accountId),
      mode,
      Result.isSuccess(snapshot) ? snapshot.success.usage : null,
      resetAt,
      observedAt,
    );
    return { mode, resetAt };
  },
);

export { availabilityFromRateLimits, observeAccount, recordUnavailableAccount };
export type { AccountAvailability };
