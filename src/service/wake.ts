import { Effect, Fiber, Queue } from 'effect';

type EngineWakeKind =
  | 'AccountObservation'
  | 'Approval'
  | 'DatabaseReplaced'
  | 'Messages'
  | 'MessagesPoll'
  | 'Reconcile'
  | 'Recovery'
  | 'Redaction'
  | 'ScheduleDue';

interface WakeTimer {
  readonly fiber: Fiber.Fiber<void>;
  readonly token: object;
}

interface WakeRuntime {
  closed: boolean;
  readonly pending: Set<EngineWakeKind>;
  readonly queue: Queue.Queue<true>;
  readonly timers: Map<string, WakeTimer>;
}

interface EngineWakeHub {
  readonly cancel: (key: string) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  readonly scheduleAfter: (
    key: string,
    kind: EngineWakeKind,
    delayMs: number,
  ) => Effect.Effect<void>;
  readonly signal: (kind: EngineWakeKind) => void;
  readonly take: Effect.Effect<ReadonlySet<EngineWakeKind>>;
}

const makeDebouncedSignal = (
  signal: () => void,
  timers: Set<ReturnType<typeof setTimeout>>,
  delayMs: number,
): (() => void) => {
  let pending: ReturnType<typeof setTimeout> | null = null;
  return (): void => {
    if (pending !== null) {
      clearTimeout(pending);
      timers.delete(pending);
    }
    pending = setTimeout(() => {
      if (pending !== null) {
        timers.delete(pending);
        pending = null;
      }
      signal();
    }, delayMs);
    timers.add(pending);
  };
};

const makeSignal =
  (runtime: WakeRuntime) =>
  (kind: EngineWakeKind): void => {
    if (runtime.closed) {
      return;
    }
    runtime.pending.add(kind);
    Queue.offerUnsafe(runtime.queue, true);
  };

const makeScheduleAfter = (
  runtime: WakeRuntime,
  signal: EngineWakeHub['signal'],
): EngineWakeHub['scheduleAfter'] =>
  Effect.fn('SpikeEngine.scheduleWakeAfter')(function* scheduleWakeAfter(
    key: string,
    kind: EngineWakeKind,
    delayMs: number,
  ) {
    const previous = runtime.timers.get(key);
    if (previous !== undefined) {
      yield* Fiber.interrupt(previous.fiber);
    }
    if (runtime.closed) {
      return;
    }
    const token = {};
    const fiber = yield* Effect.gen(function* wakeAfterDelay() {
      yield* Effect.sleep(Math.max(0, delayMs));
      yield* Effect.sync(() => {
        if (runtime.timers.get(key)?.token !== token) {
          return;
        }
        runtime.timers.delete(key);
        signal(kind);
      });
    }).pipe(Effect.forkDetach);
    runtime.timers.set(key, { fiber, token });
  });

const makeCancel = (runtime: WakeRuntime): EngineWakeHub['cancel'] =>
  Effect.fn('SpikeEngine.cancelWakeTimer')(function* cancelWakeTimer(key: string) {
    const existing = runtime.timers.get(key);
    if (existing === undefined) {
      return;
    }
    runtime.timers.delete(key);
    yield* Fiber.interrupt(existing.fiber);
  });

const makeTake = (runtime: WakeRuntime): EngineWakeHub['take'] =>
  Queue.take(runtime.queue).pipe(
    Effect.andThen(
      Effect.sync(() => {
        const batch = new Set(runtime.pending);
        runtime.pending.clear();
        return batch;
      }),
    ),
  );

const makeClose = (runtime: WakeRuntime): EngineWakeHub['close'] =>
  Effect.gen(function* closeWakeHub() {
    if (runtime.closed) {
      return;
    }
    runtime.closed = true;
    const fibers = [...runtime.timers.values()].map(({ fiber }) => fiber);
    runtime.timers.clear();
    yield* Fiber.interruptAll(fibers);
    yield* Queue.shutdown(runtime.queue);
  });

const makeEngineWakeHub = Effect.fn('SpikeEngine.makeWakeHub')(function* makeEngineWakeHub() {
  const runtime: WakeRuntime = {
    closed: false,
    pending: new Set(),
    queue: yield* Queue.dropping<true>(1),
    timers: new Map(),
  };
  const signal = makeSignal(runtime);
  return {
    cancel: makeCancel(runtime),
    close: makeClose(runtime),
    scheduleAfter: makeScheduleAfter(runtime, signal),
    signal,
    take: makeTake(runtime),
  } satisfies EngineWakeHub;
});

export { makeDebouncedSignal, makeEngineWakeHub };
export type { EngineWakeHub, EngineWakeKind };
