import { Effect } from 'effect';

import type { ThreadSnapshot } from '../src/codex/reconcile';
import type { CodexRuntime } from '../src/codex/runtime-types';
import type { MessagesTransport } from '../src/delivery/messages-transport';
import type { CodexTurnId } from '../src/domain/ids';
import { makeRuntimeHarness, type RuntimeTrace, type TurnBehavior } from './fake-codex-runtime';

interface CountLatch {
  readonly notify: () => void;
  readonly wait: (count: number) => Effect.Effect<void>;
}

interface DeliveryReceipt {
  readonly guid: string;
  readonly rowId: number;
  readonly text: string;
}

interface RuntimeFixture {
  readonly awaitTurnsCompleted: (count: number) => Effect.Effect<void>;
  readonly awaitTurnsStarted: (count: number) => Effect.Effect<void>;
  readonly runtime: CodexRuntime;
  readonly trace: RuntimeTrace;
}

const makeCountLatch = (read: () => number): CountLatch => {
  const waiters = new Set<{
    readonly count: number;
    readonly resume: (effect: Effect.Effect<undefined>) => void;
  }>();
  return {
    notify: (): void => {
      for (const waiter of waiters) {
        if (read() >= waiter.count) {
          waiters.delete(waiter);
          waiter.resume(Effect.undefined);
        }
      }
    },
    wait: (count): Effect.Effect<void> =>
      Effect.callback<undefined>((resume): Effect.Effect<void> => {
        if (read() >= count) {
          resume(Effect.undefined);
          return Effect.void;
        }
        const waiter = { count, resume };
        waiters.add(waiter);
        return Effect.sync(() => {
          waiters.delete(waiter);
        });
      }),
  };
};

const makeTransport = (
  sent: string[],
  receipts: DeliveryReceipt[],
  notifySent: () => void,
): MessagesTransport => ({
  close: (): void => undefined,
  findMatchingAfter: (frontier, text): ReturnType<MessagesTransport['findMatchingAfter']> =>
    Effect.sync(() => {
      const receipt = receipts.findLast((item) => item.text === text && item.rowId > frontier);
      return receipt === undefined ? null : { guid: receipt.guid, rowId: receipt.rowId };
    }),
  frontier: Effect.sync(() => sent.length),
  refresh: Effect.void,
  send: (text): Effect.Effect<void> =>
    Effect.sync(() => {
      sent.push(text);
      const rowId = sent.length;
      receipts.push({ guid: `integration-sent-${String(rowId)}`, rowId, text });
      notifySent();
    }),
});

const makeRuntime = (
  behavior: TurnBehavior,
  snapshot: ThreadSnapshot,
  nextTurnId: () => CodexTurnId,
): RuntimeFixture => {
  const { runtime: base, trace } = makeRuntimeHarness(behavior, snapshot);
  let turnsCompleted = 0;
  const completed = makeCountLatch(() => turnsCompleted);
  const started = makeCountLatch(() => trace.turnsStarted.length);
  return {
    awaitTurnsCompleted: completed.wait,
    awaitTurnsStarted: started.wait,
    runtime: {
      ...base,
      startTurn: (input) =>
        base.startTurn(input).pipe(
          Effect.map(() => {
            const turnId = nextTurnId();
            trace.turnsStarted[trace.turnsStarted.length - 1] = turnId;
            started.notify();
            return turnId;
          }),
        ),
      waitForTurn: (...arguments_) =>
        base.waitForTurn(...arguments_).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              turnsCompleted += 1;
              completed.notify();
            }),
          ),
        ),
    },
    trace,
  };
};

export { makeCountLatch, makeRuntime, makeTransport };
export type { CountLatch, DeliveryReceipt };
