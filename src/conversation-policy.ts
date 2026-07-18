import { Effect, Result, Semaphore } from 'effect';

import type { JournalTransactionError } from './errors';
import type { ConversationDiagnostic } from './journal/conversation-diagnostic';

type ConversationValidationTrigger = 'DatabaseChanged' | 'Periodic' | 'Startup';

interface ConversationAvailability {
  readonly awaitAvailable: Effect.Effect<unknown>;
}

interface ConversationPolicy extends ConversationAvailability {
  readonly close: () => void;
  readonly isAvailable: Effect.Effect<boolean>;
  readonly revalidate: (
    at: Date,
    trigger: ConversationValidationTrigger,
  ) => Effect.Effect<boolean, JournalTransactionError>;
  readonly revalidateIfDue: (at: Date) => Effect.Effect<boolean, JournalTransactionError>;
}

interface ConversationPolicyOptions {
  readonly diagnostic: ConversationDiagnostic;
  readonly initialValidationAt: Date;
  readonly probe: () => Effect.Effect<void, unknown>;
  readonly validationIntervalMs?: number;
}

type ConversationState = 'Available' | 'Unavailable' | 'Unchecked' | 'Validating';

interface PolicyState {
  closed: boolean;
  nextValidationAt: number;
  status: ConversationState;
}

type Waiter = (effect: Effect.Effect<boolean>) => void;

interface PolicyRuntime {
  readonly interval: number;
  readonly options: ConversationPolicyOptions;
  readonly state: PolicyState;
  readonly waiters: Set<Waiter>;
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const VALIDATION_MINUTES = 5;
const DEFAULT_VALIDATION_INTERVAL_MS =
  VALIDATION_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const releaseWaiters = (waiters: Set<Waiter>, effect: Effect.Effect<boolean>): void => {
  for (const waiter of waiters) {
    waiter(effect);
  }
  waiters.clear();
};

const makeAwaitAvailable = (state: PolicyState, waiters: Set<Waiter>): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    if (state.status === 'Available' && !state.closed) {
      resume(Effect.succeed(true));
      return Effect.void;
    }
    if (state.closed) {
      resume(Effect.interrupt);
      return Effect.void;
    }
    waiters.add(resume);
    return Effect.sync(() => {
      waiters.delete(resume);
    });
  });

const isClosed = (runtime: PolicyRuntime): boolean => runtime.state.closed;

const revalidateUnlocked = Effect.fn('ConversationPolicy.revalidate')(function* validate(
  runtime: PolicyRuntime,
  at: Date,
  trigger: ConversationValidationTrigger,
) {
  if (isClosed(runtime)) {
    return false;
  }
  yield* Effect.annotateCurrentSpan({ 'messages.validation.trigger': trigger });
  runtime.state.status = 'Validating';
  const checked = yield* Effect.result(runtime.options.probe());
  runtime.state.nextValidationAt = at.getTime() + runtime.interval;
  if (isClosed(runtime)) {
    return false;
  }
  if (Result.isFailure(checked)) {
    runtime.state.status = 'Unavailable';
    yield* runtime.options.diagnostic.open(at);
    return false;
  }
  const resolved = yield* Effect.result(runtime.options.diagnostic.resolve(at));
  if (Result.isFailure(resolved)) {
    runtime.state.status = 'Unavailable';
    return yield* Effect.fail(resolved.failure);
  }
  if (isClosed(runtime)) {
    return false;
  }
  runtime.state.status = 'Available';
  releaseWaiters(runtime.waiters, Effect.succeed(true));
  return true;
});

const makeClose =
  (runtime: PolicyRuntime): (() => void) =>
  () => {
    if (runtime.state.closed) {
      return;
    }
    runtime.state.closed = true;
    releaseWaiters(runtime.waiters, Effect.interrupt);
  };

const makeConversationPolicy = Effect.fn('ConversationPolicy.make')(function* makePolicy(
  options: ConversationPolicyOptions,
) {
  const interval = options.validationIntervalMs ?? DEFAULT_VALIDATION_INTERVAL_MS;
  const semaphore = yield* Semaphore.make(1);
  const runtime: PolicyRuntime = {
    interval,
    options,
    state: {
      closed: false,
      nextValidationAt: options.initialValidationAt.getTime() + interval,
      status: 'Unchecked',
    },
    waiters: new Set(),
    withPermit: (effect) => semaphore.withPermit(effect),
  };
  const revalidate: ConversationPolicy['revalidate'] = (at, trigger) =>
    runtime.withPermit(revalidateUnlocked(runtime, at, trigger));
  return {
    awaitAvailable: makeAwaitAvailable(runtime.state, runtime.waiters),
    close: makeClose(runtime),
    isAvailable: Effect.sync(() => runtime.state.status === 'Available' && !runtime.state.closed),
    revalidate,
    revalidateIfDue: (at): Effect.Effect<boolean, JournalTransactionError> =>
      at.getTime() < runtime.state.nextValidationAt
        ? Effect.succeed(runtime.state.status === 'Available' && !runtime.state.closed)
        : revalidate(at, 'Periodic'),
  } satisfies ConversationPolicy;
});

export { makeConversationPolicy };
export type {
  ConversationAvailability,
  ConversationPolicy,
  ConversationPolicyOptions,
  ConversationValidationTrigger,
};
