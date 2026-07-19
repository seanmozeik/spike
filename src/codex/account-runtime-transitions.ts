import { Effect } from 'effect';

import type {
  AccountRuntimeCoordinatorOptions,
  AccountRuntimeStateController,
  AcquireDecision,
} from './account-runtime-state';

const waitForCapacity = Effect.fn('SpikeAccounts.waitForCapacity')(function* waitForCapacity(
  state: AccountRuntimeStateController,
  options: AccountRuntimeCoordinatorOptions,
  retryAt: Date,
  wakeVersion: number,
): Generator<
  Effect.Effect<void, unknown>,
  Extract<AcquireDecision, { readonly kind: 'Wait' }>,
  never
> {
  yield* state.set({ kind: 'WaitingForCapacity', retryAt });
  yield* options.onWaitingForCapacity?.(retryAt) ?? Effect.void;
  return { kind: 'Wait', retryAt, wakeVersion };
});

const waitForAuthentication = Effect.fn('SpikeAccounts.waitForAuthentication')(
  function* waitForAuthentication(
    state: AccountRuntimeStateController,
    options: AccountRuntimeCoordinatorOptions,
    wakeVersion: number,
  ): Generator<
    Effect.Effect<void, unknown>,
    Extract<AcquireDecision, { readonly kind: 'Wait' }>,
    never
  > {
    yield* state.set({ kind: 'WaitingForAuthentication' });
    yield* options.onWaitingForAuthentication?.() ?? Effect.void;
    return { kind: 'Wait', retryAt: null, wakeVersion };
  },
);

export { waitForAuthentication, waitForCapacity };
