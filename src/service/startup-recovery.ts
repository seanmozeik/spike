import { Effect, Result } from 'effect';

import type { SchedulerController } from '../scheduler/controller';
import { captureAccountFailure } from './account-failover';
import { report, type EngineContext } from './context';
import { failTurn } from './turn-failure';
import { recoverActive } from './turn-recovery';

const recoverStartup = Effect.fn('SpikeEngine.recoverStartup')(function* recoverStartup(
  context: EngineContext,
  controller: SchedulerController,
): Effect.fn.Return<boolean, unknown> {
  if (!context.recoveryPending.value) {
    return true;
  }
  yield* controller.reloadBeforeActivation(context.now());
  context.recoveryPending.value = false;
  const state = yield* controller.snapshot;
  const recovery = yield* Effect.result(recoverActive(context, controller));
  if (Result.isSuccess(recovery)) {
    return true;
  }
  if (state.active === null) {
    report(context, recovery.failure);
    return true;
  }
  if (yield* captureAccountFailure(context, controller, recovery.failure)) {
    return false;
  }
  yield* failTurn(
    context,
    { generationId: state.generationId, logicalTurnId: state.active.logicalTurnId },
    recovery.failure,
  );
  return true;
});

export { recoverStartup };
