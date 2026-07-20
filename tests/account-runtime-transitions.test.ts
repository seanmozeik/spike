import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { expect } from 'vitest';

import { AccountRuntimeStateController } from '../src/codex/account-runtime-state';
import { waitForAuthentication, waitForCapacity } from '../src/codex/account-runtime-transitions';

interface CallbackBarrier {
  readonly effect: Effect.Effect<void>;
  readonly release: () => void;
  readonly started: Effect.Effect<void>;
}

const callbackBarrier = (): CallbackBarrier => {
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  return {
    effect: Effect.promise(async () => {
      started.resolve();
      await release.promise;
    }),
    release: (): void => {
      release.resolve();
    },
    started: Effect.promise(() => started.promise).pipe(Effect.asVoid),
  };
};

const expectWake = (
  state: AccountRuntimeStateController,
  retryAt: Date | null,
  wakeVersion: number,
): Effect.Effect<void> =>
  Effect.gen(function* preservedWake() {
    const outcome = yield* Effect.raceFirst(
      state.wait(retryAt, wakeVersion, new Date()).pipe(Effect.as('woke')),
      Effect.sleep('100 millis').pipe(Effect.as('timed-out')),
    );
    expect(outcome).toBe('woke');
  });

it.effect('preserves an account wake while the authentication notice callback is pending', () =>
  Effect.gen(function* authenticationWakeFixture() {
    const state = yield* AccountRuntimeStateController.make;
    const barrier = callbackBarrier();
    const wakeVersion = state.version;
    const transition = yield* Effect.forkChild(
      waitForAuthentication(
        state,
        { onWaitingForAuthentication: () => barrier.effect },
        wakeVersion,
      ),
    );

    yield* barrier.started.pipe(Effect.timeout('2 seconds'));
    yield* state.notify();
    barrier.release();
    const decision = yield* Fiber.join(transition);

    yield* expectWake(state, decision.retryAt, decision.wakeVersion);
  }),
);

it.effect('preserves an account wake while the capacity notice callback is pending', () =>
  Effect.gen(function* capacityWakeFixture() {
    const state = yield* AccountRuntimeStateController.make;
    const barrier = callbackBarrier();
    const retryAt = new Date('2099-01-01T00:00:00.000Z');
    const wakeVersion = state.version;
    const transition = yield* Effect.forkChild(
      waitForCapacity(state, { onWaitingForCapacity: () => barrier.effect }, retryAt, wakeVersion),
    );

    yield* barrier.started.pipe(Effect.timeout('2 seconds'));
    yield* state.notify();
    barrier.release();
    const decision = yield* Fiber.join(transition);

    yield* expectWake(state, decision.retryAt, decision.wakeVersion);
  }),
);
