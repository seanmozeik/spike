import type {
  PooledMessage,
  SchedulerAction,
  SchedulerEvent,
  SchedulerState,
  SchedulerTransition,
} from './model';

const QUIET_WINDOW_MS = 3000;
const HARD_CAP_MS = 10_000;

const poolDeadline = (pool: readonly PooledMessage[]): Date | null => {
  const [first] = pool;
  const last = pool.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }
  return new Date(
    Math.min(last.receivedAt.getTime() + QUIET_WINDOW_MS, first.receivedAt.getTime() + HARD_CAP_MS),
  );
};

const withScheduledPool = (
  state: SchedulerState,
  pool: readonly PooledMessage[],
): SchedulerTransition => {
  const deadlineAt = poolDeadline(pool);
  return {
    actions: deadlineAt === null ? [] : [{ deadlineAt, kind: 'SchedulePool' }],
    state: { ...state, pool },
  };
};

const startTurn = (
  state: SchedulerState,
  logicalTurnId: Extract<SchedulerAction, { kind: 'StartTurn' }>['logicalTurnId'],
  messages: readonly PooledMessage[],
  prefix: readonly SchedulerAction[] = [],
): SchedulerTransition => ({
  actions: [...prefix, { kind: 'StartTurn', logicalTurnId, messages }],
  state: { ...state, active: { acknowledged: false, codexTurnId: null, logicalTurnId }, pool: [] },
});

const handleInbound = (
  state: SchedulerState,
  event: Extract<SchedulerEvent, { kind: 'Inbound' }>,
): SchedulerTransition => {
  const command = event.message.text.trim().toLowerCase();
  if (command === '/status') {
    return { actions: [{ commandMessageId: event.message.id, kind: 'ReplyStatus' }], state };
  }
  if (command === '/new') {
    return {
      actions: [
        {
          commandMessageId: event.message.id,
          kind: 'ResetGeneration',
          newGenerationId: event.newGenerationId,
          oldGenerationId: state.generationId,
        },
        { kind: 'BindThread' },
        { commandMessageId: event.message.id, kind: 'ReplyNewChat' },
      ],
      state: {
        active: null,
        codexThreadId: null,
        generationBroken: false,
        generationId: event.newGenerationId,
        pool: [],
      },
    };
  }
  if (state.generationBroken) {
    return { actions: [], state: { ...state, pool: [...state.pool, event.message] } };
  }
  if (state.active === null) {
    return startTurn(state, event.nextLogicalTurnId, [event.message]);
  }
  return withScheduledPool(state, [...state.pool, event.message]);
};

const handlePoolTimer = (
  state: SchedulerState,
  event: Extract<SchedulerEvent, { kind: 'PoolTimer' }>,
): SchedulerTransition => {
  if (state.generationBroken) {
    return { actions: [], state };
  }
  const deadlineAt = poolDeadline(state.pool);
  if (deadlineAt === null) {
    return { actions: [], state };
  }
  if (event.deadlineAt < deadlineAt) {
    return { actions: [{ deadlineAt, kind: 'SchedulePool' }], state };
  }
  if (state.active?.codexTurnId === null || state.active === null) {
    return { actions: [], state };
  }
  return {
    actions: [
      {
        codexTurnId: state.active.codexTurnId,
        kind: 'SteerTurn',
        logicalTurnId: state.active.logicalTurnId,
        messages: state.pool,
      },
    ],
    state: { ...state, pool: [] },
  };
};

const transitionScheduler = (state: SchedulerState, event: SchedulerEvent): SchedulerTransition => {
  if (event.kind === 'Inbound') {
    return handleInbound(state, event);
  }
  if (event.kind === 'PoolTimer') {
    return handlePoolTimer(state, event);
  }
  if (event.kind === 'ThreadBound') {
    return { actions: [], state: { ...state, codexThreadId: event.codexThreadId } };
  }
  if (state.active === null || state.active.logicalTurnId !== event.logicalTurnId) {
    return { actions: [{ event: event.kind, kind: 'IgnoreLateEvent' }], state };
  }
  if (event.kind === 'AcknowledgementEmitted') {
    if (state.active.acknowledged) {
      return { actions: [], state };
    }
    return {
      actions: [
        { at: event.at, kind: 'RecordAcknowledgement', logicalTurnId: event.logicalTurnId },
      ],
      state: { ...state, active: { ...state.active, acknowledged: true } },
    };
  }
  if (event.kind === 'TurnStarted') {
    const nextState = { ...state, active: { ...state.active, codexTurnId: event.codexTurnId } };
    const deadlineAt = poolDeadline(state.pool);
    if (deadlineAt !== null && deadlineAt <= event.at) {
      return handlePoolTimer(nextState, { deadlineAt: event.at, kind: 'PoolTimer' });
    }
    return { actions: [], state: nextState };
  }
  if (event.kind === 'GenerationBroken') {
    return {
      actions: [{ kind: 'FailTurn', logicalTurnId: event.logicalTurnId }],
      state: { ...state, active: null, generationBroken: true },
    };
  }
  const complete: SchedulerAction = {
    kind: event.kind === 'TurnFailed' ? 'FailTurn' : 'CompleteTurn',
    logicalTurnId: event.logicalTurnId,
  };
  if (state.pool.length > 0) {
    return startTurn({ ...state, active: null }, event.nextLogicalTurnId, state.pool, [complete]);
  }
  return { actions: [complete], state: { ...state, active: null } };
};

export { HARD_CAP_MS, QUIET_WINDOW_MS, poolDeadline, transitionScheduler };
