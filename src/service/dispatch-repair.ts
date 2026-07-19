import { Effect } from 'effect';

import type { SchedulerState, TurnIdentity } from '../scheduler/model';
import { ownsActiveTurn } from '../scheduler/ownership';
import { report, type EngineContext } from './context';
import { failTurn } from './turn-failure';

const dispatchFailureIdentity = (
  state: SchedulerState,
  expectedNewLogicalTurnId: TurnIdentity['logicalTurnId'],
  previousIdentity: TurnIdentity | null,
): TurnIdentity | null => {
  if (state.active?.logicalTurnId === expectedNewLogicalTurnId) {
    return { generationId: state.generationId, logicalTurnId: expectedNewLogicalTurnId };
  }
  if (previousIdentity !== null && ownsActiveTurn(state, previousIdentity)) {
    return previousIdentity;
  }
  return null;
};

const repairDispatchFailure = Effect.fn('SpikeEngine.repairDispatchFailure')(
  function* repairDispatchFailure(
    context: EngineContext,
    state: SchedulerState,
    expectedNewLogicalTurnId: TurnIdentity['logicalTurnId'],
    previousIdentity: TurnIdentity | null,
    error: unknown,
  ) {
    const identity = dispatchFailureIdentity(state, expectedNewLogicalTurnId, previousIdentity);
    if (identity === null) {
      report(context, error);
      context.wakes.signal('Recovery');
      return false;
    }
    yield* failTurn(context, identity, error);
    return true;
  },
);

export { dispatchFailureIdentity, repairDispatchFailure };
