import { randomUUID } from 'node:crypto';

import { Effect, Result } from 'effect';

import { recordUnavailableAccount } from '../codex/account-observation';
import { compactError } from '../delivery/service';
import { GenerationId, LogicalTurnId as LogicalTurnIdSchema } from '../domain/ids';
import { isGenerationBroken } from '../errors';
import type { SchedulerState, TurnIdentity } from '../scheduler/model';
import { ownsActiveTurn } from '../scheduler/ownership';
import { classifyAccountFailure } from './account-failover';
import { report, type EngineContext } from './context';
import type {
  CompletionTerminalObligation,
  FailureTerminalEvent,
  FailureTerminalObligation,
  TurnTerminalObligation,
} from './turn-terminal-model';
import { terminalSuccessorIdentity } from './turn-terminal-successor';

const MAX_TERMINALS_PER_DRAIN = 8;

const sourceId = (state: SchedulerState, identity: TurnIdentity): string =>
  state.active?.logicalTurnId === identity.logicalTurnId && state.active.codexTurnId !== null
    ? state.active.codexTurnId
    : identity.logicalTurnId;

const failureEvent = (
  context: EngineContext,
  identity: TurnIdentity,
  error: unknown,
): FailureTerminalEvent =>
  isGenerationBroken(error)
    ? {
        at: context.now(),
        kind: 'GenerationBroken',
        logicalTurnId: identity.logicalTurnId,
        newGenerationId: GenerationId.make(randomUUID()),
        nextLogicalTurnId: LogicalTurnIdSchema.make(randomUUID()),
      }
    : {
        at: context.now(),
        kind: 'TurnFailed',
        logicalTurnId: identity.logicalTurnId,
        newGenerationId: GenerationId.make(randomUUID()),
        nextLogicalTurnId: LogicalTurnIdSchema.make(randomUUID()),
      };

const deliverFailure = (
  context: EngineContext,
  obligation: FailureTerminalObligation,
): Effect.Effect<void> =>
  Effect.gen(function* deliverTurnFailure() {
    const delivered = yield* Effect.result(
      context.options.delivery.deliverFailureNotice(
        obligation.identity.logicalTurnId,
        `Spike hit an error: ${compactError(obligation.error)}`,
        context.now(),
      ),
    );
    if (Result.isFailure(delivered)) {
      report(context, delivered.failure);
    }
  });

const registerSuccessorFailure = (
  context: EngineContext,
  state: SchedulerState,
  identity: TurnIdentity,
  error: unknown,
): void => {
  if (!context.turnTerminals.pending.has(identity.logicalTurnId)) {
    context.turnTerminals.pending.set(identity.logicalTurnId, {
      error,
      event: failureEvent(context, identity, error),
      identity,
      kind: 'Failure',
      sourceId: sourceId(state, identity),
    });
    context.wakes.signal('Recovery');
  }
};

const finishDeliveredAttempt = (
  context: EngineContext,
  obligation: CompletionTerminalObligation,
): Effect.Effect<boolean> =>
  context.codexJournal
    .finishLogicalTurn(obligation.identity.logicalTurnId, 'Completed', obligation.event.at)
    .pipe(
      Effect.result,
      Effect.map((finished) => {
        if (Result.isFailure(finished)) {
          report(context, finished.failure);
          return false;
        }
        return true;
      }),
    );

const finishSuccessfulTerminal = (
  context: EngineContext,
  obligation: TurnTerminalObligation,
  after: SchedulerState,
): Effect.Effect<void> => {
  context.turnTerminals.pending.delete(obligation.identity.logicalTurnId);
  const terminalOwned =
    after.generationId === obligation.identity.generationId ||
    after.generationId === obligation.event.newGenerationId;
  return obligation.kind === 'Failure' && terminalOwned
    ? deliverFailure(context, obligation)
    : Effect.void;
};

const reconcileFailedTerminal = (
  context: EngineContext,
  obligation: TurnTerminalObligation,
  after: SchedulerState,
  error: unknown,
): Effect.Effect<'Blocked' | 'Continue'> =>
  Effect.gen(function* reconcileFailedTerminalDispatch() {
    report(context, error);
    if (ownsActiveTurn(after, obligation.identity)) {
      return 'Blocked' as const;
    }
    context.turnTerminals.pending.delete(obligation.identity.logicalTurnId);
    const successor = terminalSuccessorIdentity(obligation, after);
    if (after.generationId !== obligation.identity.generationId) {
      if (successor !== null) {
        registerSuccessorFailure(context, after, successor, error);
      }
      return 'Continue' as const;
    }
    if (obligation.kind === 'Failure') {
      yield* deliverFailure(context, obligation);
    }
    if (successor !== null) {
      registerSuccessorFailure(context, after, successor, error);
    }
    return 'Continue' as const;
  });

const processTerminal = Effect.fn('SpikeEngine.processTurnTerminal')(function* processTurnTerminal(
  context: EngineContext,
  obligation: TurnTerminalObligation,
) {
  const controller = yield* Effect.promise(() => context.controllerReady.promise);
  const before = yield* controller.snapshot;
  if (!ownsActiveTurn(before, obligation.identity)) {
    context.turnTerminals.pending.delete(obligation.identity.logicalTurnId);
    if (obligation.kind === 'Failure') {
      report(context, obligation.error);
    }
    return 'Continue' as const;
  }

  if (obligation.kind === 'Completion' && !(yield* finishDeliveredAttempt(context, obligation))) {
    return 'Blocked' as const;
  }

  const dispatched = yield* Effect.result(controller.dispatch(obligation.event));
  const after = yield* controller.snapshot;
  if (Result.isSuccess(dispatched)) {
    yield* finishSuccessfulTerminal(context, obligation, after);
    return 'Continue' as const;
  }
  return yield* reconcileFailedTerminal(context, obligation, after, dispatched.failure);
});

const drainTurnTerminals = (context: EngineContext): Effect.Effect<void> =>
  Effect.gen(function* drainPendingTerminals() {
    for (let processed = 0; processed < MAX_TERMINALS_PER_DRAIN; processed += 1) {
      const obligation = context.turnTerminals.pending.values().next().value;
      if (obligation === undefined) {
        return;
      }
      if ((yield* processTerminal(context, obligation)) === 'Blocked') {
        return;
      }
    }
  });

const serializeTerminalWork = (
  context: EngineContext,
  work: Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    const previous = context.turnTerminals.tail;
    const handled = (async (): Promise<void> => {
      await previous;
      try {
        await Effect.runPromise(work);
      } catch (error) {
        report(context, error);
      }
    })();
    context.turnTerminals.tail = handled;
    await handled;
  });

const failTurn = Effect.fn('SpikeEngine.failTurn')(function* failTurn(
  context: EngineContext,
  identity: TurnIdentity,
  error: unknown,
) {
  yield* serializeTerminalWork(
    context,
    Effect.gen(function* queueFailedTurn() {
      const controller = yield* Effect.promise(() => context.controllerReady.promise);
      const state = yield* controller.snapshot;
      if (!ownsActiveTurn(state, identity)) {
        report(context, error);
        return;
      }
      if (!context.turnTerminals.pending.has(identity.logicalTurnId)) {
        report(context, error);
        context.turnTerminals.pending.set(identity.logicalTurnId, {
          error,
          event: failureEvent(context, identity, error),
          identity,
          kind: 'Failure',
          sourceId: sourceId(state, identity),
        });
        context.wakes.signal('Recovery');
      }
      yield* drainTurnTerminals(context);
    }),
  );
  const availability = classifyAccountFailure(error);
  if (availability !== null && !context.options.runtime.accountId.startsWith('provider:')) {
    const recorded = yield* Effect.result(
      recordUnavailableAccount(
        context.options.runtime,
        context.codexJournal,
        availability,
        context.now(),
      ),
    );
    if (Result.isFailure(recorded)) {
      report(context, recorded.failure);
    }
    context.accountFailover.pending = availability;
  }
});

const completeTurn = Effect.fn('SpikeEngine.completeTurn')(function* completeTurn(
  context: EngineContext,
  identity: TurnIdentity,
) {
  yield* serializeTerminalWork(
    context,
    Effect.gen(function* queueCompletedTurn() {
      const controller = yield* Effect.promise(() => context.controllerReady.promise);
      const state = yield* controller.snapshot;
      if (!ownsActiveTurn(state, identity)) {
        return;
      }
      if (!context.turnTerminals.pending.has(identity.logicalTurnId)) {
        context.turnTerminals.pending.set(identity.logicalTurnId, {
          event: {
            at: context.now(),
            kind: 'TurnCompleted',
            logicalTurnId: identity.logicalTurnId,
            newGenerationId: GenerationId.make(randomUUID()),
            nextLogicalTurnId: LogicalTurnIdSchema.make(randomUUID()),
          },
          identity,
          kind: 'Completion',
          sourceId: sourceId(state, identity),
        });
        context.wakes.signal('Recovery');
      }
      yield* drainTurnTerminals(context);
    }),
  );
});

const retryTurnTerminals = (context: EngineContext): Effect.Effect<void> =>
  serializeTerminalWork(context, drainTurnTerminals(context));

export { completeTurn, failTurn, retryTurnTerminals };
