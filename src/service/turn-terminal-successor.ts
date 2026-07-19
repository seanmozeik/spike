import type { SchedulerState, TurnIdentity } from '../scheduler/model';
import type { TurnTerminalObligation } from './turn-terminal-model';

const terminalSuccessorIdentity = (
  obligation: TurnTerminalObligation,
  state: SchedulerState,
): TurnIdentity | null => {
  if (obligation.event.kind === 'GenerationBroken') {
    return null;
  }
  const { active } = state;
  if (active === null || active.logicalTurnId !== obligation.event.nextLogicalTurnId) {
    return null;
  }
  if (
    state.generationId !== obligation.identity.generationId &&
    state.generationId !== obligation.event.newGenerationId
  ) {
    return null;
  }
  return { generationId: state.generationId, logicalTurnId: active.logicalTurnId };
};

export { terminalSuccessorIdentity };
