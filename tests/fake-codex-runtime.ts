import { Effect } from 'effect';

import type { ClassifiedOutput } from '../src/codex/output-classifier';
import type { ThreadSnapshot } from '../src/codex/reconcile';
import type { JsonRpcNotification } from '../src/codex/rpc';
import type { CodexRuntime } from '../src/codex/runtime';
import type { CodexServerRequest, JsonRpcId } from '../src/codex/server-request-registry';
import { CodexThreadId, CodexTurnId } from '../src/domain/ids';
import { CodexRuntimeError, GenerationBroken } from '../src/errors';

interface TurnBehavior {
  readonly acknowledgement?: string;
  readonly approvalExpiryMs?: number;
  readonly compactions?: readonly string[];
  readonly deliveryFailure?: string;
  readonly failure?: string;
  readonly finalAnswer?: string;
  readonly gate?: Promise<void>;
  readonly resumeFailure?: string;
  readonly resumeRuntimeFailure?: string;
  readonly responseFailure?: string;
  readonly startFailure?: string;
  readonly startFailureAfter?: number;
  readonly statusFailure?: string;
  readonly steerFailure?: string;
  readonly steerGate?: Promise<void>;
}

interface RuntimeTrace {
  readonly closeListeners: (() => void)[];
  readonly inputs: string[];
  readonly notificationListeners: ((notification: JsonRpcNotification) => void)[];
  readonly reads: string[];
  readonly requestListeners: ((request: CodexServerRequest) => void)[];
  readonly responses: { readonly id: JsonRpcId; readonly result: unknown }[];
  readonly resumed: string[];
  readonly steers: string[];
  readonly turnsStarted: string[];
}

const makeWaitForTurn =
  (behavior: TurnBehavior): CodexRuntime['waitForTurn'] =>
  (_threadId, _turnId, handlers) =>
    Effect.gen(function* wait() {
      if (behavior.acknowledgement !== undefined) {
        handlers.onAcknowledgement(behavior.acknowledgement);
      }
      for (const itemId of behavior.compactions ?? []) {
        handlers.onCompactionStarted(itemId);
      }
      if (behavior.failure !== undefined) {
        return yield* new CodexRuntimeError({
          cause: new Error(behavior.failure),
          message: behavior.failure,
          operation: 'turn/wait',
        });
      }
      if (behavior.gate !== undefined) {
        yield* Effect.promise(() => behavior.gate ?? Promise.resolve());
      }
      return {
        acknowledgement: behavior.acknowledgement ?? null,
        finalAnswer: behavior.finalAnswer ?? 'Done.',
      } satisfies ClassifiedOutput;
    });

const makeResumeThread =
  (
    behavior: TurnBehavior,
    trace: RuntimeTrace,
    loaded: Set<string>,
  ): CodexRuntime['resumeThread'] =>
  (threadId) => {
    trace.resumed.push(threadId);
    if (behavior.resumeRuntimeFailure !== undefined) {
      return new CodexRuntimeError({
        cause: new Error(behavior.resumeRuntimeFailure),
        message: behavior.resumeRuntimeFailure,
        operation: 'thread/resume',
      });
    }
    if (behavior.resumeFailure !== undefined) {
      return new GenerationBroken({ message: behavior.resumeFailure });
    }
    loaded.add(threadId);
    return Effect.void;
  };

const makeStartTurn =
  (behavior: TurnBehavior, trace: RuntimeTrace): CodexRuntime['startTurn'] =>
  ({ input }) =>
    Effect.gen(function* startTurn() {
      trace.inputs.push(input);
      if (
        behavior.startFailure !== undefined &&
        trace.turnsStarted.length >= (behavior.startFailureAfter ?? 0)
      ) {
        return yield* new CodexRuntimeError({
          cause: new Error(behavior.startFailure),
          message: behavior.startFailure,
          operation: 'turn/start',
        });
      }
      const turnId = `turn-${trace.turnsStarted.length + 1}`;
      trace.turnsStarted.push(turnId);
      return CodexTurnId.make(turnId);
    });

const subscribe = <A>(listeners: A[], listener: A): (() => void) => {
  listeners.push(listener);
  return (): void => {
    const index = listeners.indexOf(listener);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
  };
};

const makeTrace = (): RuntimeTrace => ({
  closeListeners: [],
  inputs: [],
  notificationListeners: [],
  reads: [],
  requestListeners: [],
  responses: [],
  resumed: [],
  steers: [],
  turnsStarted: [],
});

const makeStartThread = (loaded: Set<string>): CodexRuntime['startThread'] => {
  let startedThreadCount = 0;
  return Effect.sync(() => {
    startedThreadCount += 1;
    const threadId = CodexThreadId.make(
      startedThreadCount === 1 ? 'thread-new' : `thread-new-${startedThreadCount}`,
    );
    loaded.add(threadId);
    return threadId;
  });
};

const makeSteerTurn =
  (behavior: TurnBehavior, trace: RuntimeTrace): CodexRuntime['steerTurn'] =>
  ({ input }) =>
    Effect.gen(function* steerTurn() {
      trace.steers.push(input);
      if (behavior.steerGate !== undefined) {
        yield* Effect.promise(() => behavior.steerGate ?? Promise.resolve());
      }
      if (behavior.steerFailure !== undefined) {
        yield* new CodexRuntimeError({
          cause: new Error(behavior.steerFailure),
          message: behavior.steerFailure,
          operation: 'turn/steer',
        });
      }
    });

const makeRuntimeHarness = (
  behavior: TurnBehavior,
  snapshot: ThreadSnapshot,
): { readonly runtime: CodexRuntime; readonly trace: RuntimeTrace } => {
  const loaded = new Set<string>();
  const trace = makeTrace();
  const runtime: CodexRuntime = {
    accountId: 'test-account',
    addConnectionCloseListener: (listener) => subscribe(trace.closeListeners, listener),
    addNotificationListener: (listener) => subscribe(trace.notificationListeners, listener),
    addServerRequestListener: (listener) => subscribe(trace.requestListeners, listener),
    archiveThread: (): Effect.Effect<void> => Effect.void,
    close: (): Promise<void> => Promise.resolve(),
    health: Effect.void,
    interruptTurn: (): Effect.Effect<void> => Effect.void,
    loadedThreads: Effect.sync(() => [...loaded].map((id) => CodexThreadId.make(id))),
    rateLimits: Effect.succeed({}),
    readThread: (threadId): Effect.Effect<ThreadSnapshot> =>
      Effect.sync(() => {
        trace.reads.push(threadId);
        return snapshot;
      }),
    respondToServerRequest: (id, result): Promise<void> => {
      trace.responses.push({ id, result });
      return behavior.responseFailure === undefined
        ? Promise.resolve()
        : Promise.reject(new Error(behavior.responseFailure));
    },
    resumeThread: makeResumeThread(behavior, trace, loaded),
    startThread: makeStartThread(loaded),
    startTurn: makeStartTurn(behavior, trace),
    steerTurn: makeSteerTurn(behavior, trace),
    usage: Effect.succeed({}),
    waitForTurn: makeWaitForTurn(behavior),
  };
  return { runtime, trace };
};

export { makeRuntimeHarness };
export type { RuntimeTrace, TurnBehavior };
