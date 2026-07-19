import { parseControlCommand } from '../domain/control-command';
import type {
  ActiveTurn,
  PooledMessage,
  SchedulerAction,
  SchedulerEvent,
  SchedulerState,
  SchedulerTransition,
} from './model';
import { rotateConfiguration, startConfiguredTurn } from './start-transition';

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
  prefix: readonly SchedulerAction[] = [],
): SchedulerTransition => {
  const deadlineAt = poolDeadline(pool);
  return {
    actions: deadlineAt === null ? prefix : [...prefix, { deadlineAt, kind: 'SchedulePool' }],
    state: { ...state, pool },
  };
};

type InboundEvent = Extract<SchedulerEvent, { readonly kind: 'Inbound' }>;
type PoolTimerEvent = Extract<SchedulerEvent, { readonly kind: 'PoolTimer' }>;
type ScheduleDueEvent = Extract<SchedulerEvent, { readonly kind: 'ScheduleDue' }>;
type TerminalTurnEvent = Extract<SchedulerEvent, { readonly kind: 'TurnCompleted' | 'TurnFailed' }>;
type ActiveTurnEvent = Exclude<
  SchedulerEvent,
  InboundEvent | PoolTimerEvent | ScheduleDueEvent | { readonly kind: 'ThreadBound' }
>;

const handleScheduleDue = (state: SchedulerState, event: ScheduleDueEvent): SchedulerTransition => {
  const claim: SchedulerAction = {
    expectedDueAt: event.expectedDueAt,
    expectedRevision: event.expectedRevision,
    kind: 'ClaimSchedule',
    message: event.message,
    nextDueAt: event.nextDueAt,
    runId: event.runId,
    scheduleId: event.scheduleId,
    scheduledFor: event.scheduledFor,
  };
  if (!state.configurationCurrent && state.active === null) {
    return startConfiguredTurn(
      state,
      event.newGenerationId,
      event.nextLogicalTurnId,
      [...state.pool, event.message],
      [claim],
    );
  }
  if (state.generationBroken) {
    return withScheduledPool(state, [...state.pool, event.message], [claim]);
  }
  if (state.active === null) {
    return startConfiguredTurn(
      state,
      event.newGenerationId,
      event.nextLogicalTurnId,
      [event.message],
      [claim],
    );
  }
  return withScheduledPool(state, [...state.pool, event.message], [claim]);
};

const resetGenerationTransition = (
  state: SchedulerState,
  event: InboundEvent,
): SchedulerTransition => ({
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
    configurationCurrent: true,
    generationBroken: false,
    generationId: event.newGenerationId,
    pool: [],
  },
});

const controlTransition = (
  state: SchedulerState,
  event: InboundEvent,
): SchedulerTransition | null => {
  const command = parseControlCommand(event.message.text);
  if (command === '/status') {
    return { actions: [{ commandMessageId: event.message.id, kind: 'ReplyStatus' }], state };
  }
  return command === '/new' ? resetGenerationTransition(state, event) : null;
};

const handleInbound = (state: SchedulerState, event: InboundEvent): SchedulerTransition => {
  const control = controlTransition(state, event);
  if (control !== null) {
    return control;
  }
  if (state.generationBroken) {
    return { actions: [], state: { ...state, pool: [...state.pool, event.message] } };
  }
  if (!state.configurationCurrent && state.active === null) {
    return startConfiguredTurn(state, event.newGenerationId, event.nextLogicalTurnId, [
      ...state.pool,
      event.message,
    ]);
  }
  if (state.active === null) {
    return startConfiguredTurn(state, event.newGenerationId, event.nextLogicalTurnId, [
      event.message,
    ]);
  }
  return withScheduledPool(state, [...state.pool, event.message]);
};

const handlePoolTimer = (state: SchedulerState, event: PoolTimerEvent): SchedulerTransition => {
  const deadlineAt = poolDeadline(state.pool);
  if (deadlineAt === null) {
    return { actions: [], state };
  }
  if (event.deadlineAt < deadlineAt) {
    return { actions: [{ deadlineAt, kind: 'SchedulePool' }], state };
  }
  if (!state.configurationCurrent && state.active === null) {
    return startConfiguredTurn(state, event.newGenerationId, event.nextLogicalTurnId, state.pool);
  }
  if (state.generationBroken) {
    return { actions: [], state };
  }
  if (state.active === null) {
    return startConfiguredTurn(state, event.newGenerationId, event.nextLogicalTurnId, state.pool);
  }
  if (state.active.codexTurnId === null) {
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

const handleAcknowledgement = (
  state: SchedulerState,
  active: ActiveTurn,
  event: Extract<SchedulerEvent, { readonly kind: 'AcknowledgementEmitted' }>,
): SchedulerTransition =>
  active.acknowledged
    ? { actions: [], state }
    : {
        actions: [
          { at: event.at, kind: 'RecordAcknowledgement', logicalTurnId: event.logicalTurnId },
        ],
        state: { ...state, active: { ...active, acknowledged: true } },
      };

const handleTurnStarted = (
  state: SchedulerState,
  active: ActiveTurn,
  event: Extract<SchedulerEvent, { readonly kind: 'TurnStarted' }>,
): SchedulerTransition => {
  const nextState = { ...state, active: { ...active, codexTurnId: event.codexTurnId } };
  const deadlineAt = poolDeadline(state.pool);
  return deadlineAt !== null && deadlineAt <= event.at
    ? handlePoolTimer(nextState, {
        deadlineAt: event.at,
        kind: 'PoolTimer',
        newGenerationId: state.generationId,
        nextLogicalTurnId: event.logicalTurnId,
      })
    : { actions: [], state: nextState };
};

const rotateAfterTurn = (
  state: SchedulerState,
  event: TerminalTurnEvent,
  completed: SchedulerAction,
): SchedulerTransition => {
  const idleState = { ...state, active: null };
  if (state.pool.length > 0) {
    return startConfiguredTurn(
      idleState,
      event.newGenerationId,
      event.nextLogicalTurnId,
      state.pool,
      [completed],
    );
  }
  const rotation = rotateConfiguration(idleState, event.newGenerationId);
  return { actions: [completed, rotation.action], state: rotation.state };
};

const handleGenerationBroken = (
  state: SchedulerState,
  event: Extract<SchedulerEvent, { readonly kind: 'GenerationBroken' }>,
): SchedulerTransition => ({
  actions: [{ kind: 'FailTurn', logicalTurnId: event.logicalTurnId }],
  state: { ...state, active: null, generationBroken: true },
});

const handleTerminalTurn = (
  state: SchedulerState,
  event: TerminalTurnEvent,
): SchedulerTransition => {
  const completed: SchedulerAction = {
    kind: event.kind === 'TurnFailed' ? 'FailTurn' : 'CompleteTurn',
    logicalTurnId: event.logicalTurnId,
  };
  if (!state.configurationCurrent) {
    return rotateAfterTurn(state, event, completed);
  }
  const idleState = { ...state, active: null };
  return state.pool.length > 0
    ? startConfiguredTurn(idleState, event.newGenerationId, event.nextLogicalTurnId, state.pool, [
        completed,
      ])
    : { actions: [completed], state: idleState };
};

const handleActiveTurnEvent = (
  state: SchedulerState,
  active: ActiveTurn,
  event: ActiveTurnEvent,
): SchedulerTransition => {
  switch (event.kind) {
    case 'AcknowledgementEmitted': {
      return handleAcknowledgement(state, active, event);
    }
    case 'TurnStarted': {
      return handleTurnStarted(state, active, event);
    }
    case 'GenerationBroken': {
      return handleGenerationBroken(state, event);
    }
    case 'TurnCompleted':
    case 'TurnFailed': {
      return handleTerminalTurn(state, event);
    }
    default: {
      const unreachable: never = event;
      throw new Error(`unsupported active scheduler event: ${String(unreachable)}`);
    }
  }
};

const transitionScheduler = (state: SchedulerState, event: SchedulerEvent): SchedulerTransition => {
  if (event.kind === 'Inbound') {
    return handleInbound(state, event);
  }
  if (event.kind === 'ScheduleDue') {
    return handleScheduleDue(state, event);
  }
  if (event.kind === 'PoolTimer') {
    return handlePoolTimer(state, event);
  }
  if (event.kind === 'ThreadBound') {
    return { actions: [], state: { ...state, codexThreadId: event.codexThreadId } };
  }
  const { active } = state;
  if (active === null || active.logicalTurnId !== event.logicalTurnId) {
    return { actions: [{ event: event.kind, kind: 'IgnoreLateEvent' }], state };
  }
  return handleActiveTurnEvent(state, active, event);
};

export { HARD_CAP_MS, QUIET_WINDOW_MS, poolDeadline, transitionScheduler };
