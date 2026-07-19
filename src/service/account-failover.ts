import { Effect, Result } from 'effect';

import { recordUnavailableAccount } from '../codex/account-observation';
import { classifyCodexAvailability } from '../codex/availability';
import { CodexRuntimeError, WaitingForAuthentication, WaitingForCapacity } from '../errors';
import type { SchedulerController } from '../scheduler/controller';
import { report, type AccountFailure, type EngineContext } from './context';

const classifyAccountFailure = (error: unknown): AccountFailure | null => {
  if (error instanceof WaitingForAuthentication || error instanceof WaitingForCapacity) {
    return error;
  }
  if (!(error instanceof CodexRuntimeError)) {
    return null;
  }
  const classified = classifyCodexAvailability(error);
  return classified instanceof CodexRuntimeError ? null : classified;
};

const requestPendingAccountFailover = Effect.fn('SpikeEngine.requestAccountFailover')(
  function* requestPendingAccountFailover(context: EngineContext, controller: SchedulerController) {
    const failure = context.accountFailover.pending;
    if (failure === null || context.accountFailover.requested) {
      return false;
    }
    const state = yield* controller.snapshot;
    if (
      (state.active !== null && state.active.codexTurnId !== null) ||
      context.monitors.size > 0 ||
      context.turnTerminals.pending.size > 0
    ) {
      return false;
    }
    if (context.approval !== null) {
      const approvals = yield* context.approval.journal.counts(context.now());
      if (approvals.pending > 0) {
        return false;
      }
    }
    context.accountFailover.requested = true;
    context.accountFailover.signal.resolve(failure);
    return true;
  },
);

const captureAccountFailure = Effect.fn('SpikeEngine.captureAccountFailure')(
  function* captureAccountFailure(
    context: EngineContext,
    controller: SchedulerController,
    error: unknown,
  ) {
    if (context.options.runtime.accountId.startsWith('provider:')) {
      return false;
    }
    const failure = classifyAccountFailure(error);
    if (failure === null) {
      return false;
    }
    const recorded = yield* Effect.result(
      recordUnavailableAccount(
        context.options.runtime,
        context.codexJournal,
        failure,
        context.now(),
      ),
    );
    if (Result.isFailure(recorded)) {
      report(context, recorded.failure);
      return false;
    }
    context.accountFailover.pending = failure;
    yield* requestPendingAccountFailover(context, controller);
    return true;
  },
);

export { captureAccountFailure, classifyAccountFailure, requestPendingAccountFailover };
export type { AccountFailure } from './context';
