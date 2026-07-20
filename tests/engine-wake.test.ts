import { it } from '@effect/vitest';
import { Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { expect } from 'vitest';

import { makeDebouncedSignal, makeEngineWakeHub } from '../src/service/wake';

it.effect('coalesces repeated wakes and retains one dirty follow-up during a pass', () =>
  Effect.gen(function* coalescedWake() {
    const hub = yield* makeEngineWakeHub();
    hub.signal('Messages');
    hub.signal('Messages');
    hub.signal('Messages');
    expect([...(yield* hub.take)]).toStrictEqual(['Messages']);

    hub.signal('Messages');
    hub.signal('Messages');
    expect([...(yield* hub.take)]).toStrictEqual(['Messages']);

    yield* hub.close;
  }),
);

it.effect('delivers approval and reconciliation timers independently', () =>
  Effect.gen(function* independentTimers() {
    const hub = yield* makeEngineWakeHub();
    yield* hub.scheduleAfter('approval', 'Approval', 10);
    yield* hub.scheduleAfter('reconcile', 'Reconcile', 10);
    yield* TestClock.adjust('10 millis');
    expect(new Set(yield* hub.take)).toStrictEqual(new Set(['Approval', 'Reconcile']));
    yield* hub.close;
  }),
);

it.effect('replaces a keyed timer and interrupts pending timers on close', () =>
  Effect.gen(function* replaceAndCloseTimers() {
    const hub = yield* makeEngineWakeHub();
    yield* hub.scheduleAfter('retry', 'Approval', 50);
    yield* hub.scheduleAfter('retry', 'Recovery', 10);
    yield* TestClock.adjust('10 millis');
    expect([...(yield* hub.take)]).toStrictEqual(['Recovery']);

    const waiting = yield* Effect.forkChild(hub.take);
    yield* hub.scheduleAfter('later', 'Messages', 10);
    yield* hub.close;
    yield* TestClock.adjust('10 millis');
    expect(Exit.isFailure(yield* Fiber.await(waiting))).toBe(true);
  }),
);

it.effect('debounces filesystem bursts into one signal', () =>
  Effect.gen(function* debouncedSignal() {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let signals = 0;
    const signal = makeDebouncedSignal(
      () => {
        signals += 1;
      },
      timers,
      5,
    );
    signal();
    signal();
    signal();
    yield* Effect.promise(() => Bun.sleep(15));
    expect(signals).toBe(1);
    expect(timers.size).toBe(0);
  }),
);
