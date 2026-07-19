import type { PooledMessage, SchedulerAction, SchedulerState, SchedulerTransition } from './model';

const rotateConfiguration = (
  state: SchedulerState,
  newGenerationId: SchedulerState['generationId'],
): { readonly action: SchedulerAction; readonly state: SchedulerState } => ({
  action: { kind: 'RotateConfiguration', newGenerationId, oldGenerationId: state.generationId },
  state: {
    ...state,
    active: null,
    codexThreadId: null,
    configurationCurrent: true,
    generationBroken: false,
    generationId: newGenerationId,
  },
});

const startTurn = (
  state: SchedulerState,
  logicalTurnId: Extract<SchedulerAction, { kind: 'StartTurn' }>['logicalTurnId'],
  messages: readonly PooledMessage[],
  prefix: readonly SchedulerAction[],
): SchedulerTransition => ({
  actions: [...prefix, { kind: 'StartTurn', logicalTurnId, messages }],
  state: { ...state, active: { acknowledged: false, codexTurnId: null, logicalTurnId }, pool: [] },
});

const startConfiguredTurn = (
  state: SchedulerState,
  newGenerationId: SchedulerState['generationId'],
  logicalTurnId: Extract<SchedulerAction, { kind: 'StartTurn' }>['logicalTurnId'],
  messages: readonly PooledMessage[],
  prefix: readonly SchedulerAction[] = [],
): SchedulerTransition => {
  if (state.active !== null) {
    throw new Error('a configured turn can only start from idle state');
  }
  if (state.configurationCurrent) {
    return startTurn(state, logicalTurnId, messages, prefix);
  }
  const rotation = rotateConfiguration(state, newGenerationId);
  return startTurn(rotation.state, logicalTurnId, messages, [...prefix, rotation.action]);
};

export { rotateConfiguration, startConfiguredTurn };
