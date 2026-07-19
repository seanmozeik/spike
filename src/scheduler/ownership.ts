import type { SchedulerState, TurnIdentity } from './model';

const ownsActiveTurn = (state: SchedulerState, identity: TurnIdentity): boolean =>
  state.generationId === identity.generationId &&
  state.active?.logicalTurnId === identity.logicalTurnId;

export { ownsActiveTurn };
