import { expect, it } from 'vitest';

import { CodexTurnId, GenerationId, InboundMessageId, LogicalTurnId } from '../src/domain/ids';
import type { PooledMessage, SchedulerState } from '../src/scheduler/model';
import { poolDeadline, transitionScheduler } from '../src/scheduler/transition';

const at = (milliseconds: number): Date => new Date(1_700_000_000_000 + milliseconds);
const message = (id: string, milliseconds: number, text = id): PooledMessage => ({
  attachments: [],
  id: InboundMessageId.make(id),
  receivedAt: at(milliseconds),
  text,
});
const idle = (): SchedulerState => ({
  active: null,
  codexThreadId: null,
  configurationCurrent: true,
  generationBroken: false,
  generationId: GenerationId.make('generation-1'),
  pool: [],
});

it('quarantines a broken generation until /new without flushing pooled input', () => {
  const active: SchedulerState = {
    ...idle(),
    active: {
      acknowledged: false,
      codexTurnId: CodexTurnId.make('codex-turn'),
      logicalTurnId: LogicalTurnId.make('turn-1'),
    },
    pool: [message('already-pooled', 10)],
  };
  const broken = transitionScheduler(active, {
    at: at(20),
    kind: 'GenerationBroken',
    logicalTurnId: LogicalTurnId.make('turn-1'),
    newGenerationId: GenerationId.make('generation-2'),
    nextLogicalTurnId: LogicalTurnId.make('turn-2'),
  });
  expect(broken.actions).toEqual([{ kind: 'FailTurn', logicalTurnId: 'turn-1' }]);
  expect(broken.state).toMatchObject({ active: null, generationBroken: true });

  const quarantined = transitionScheduler(broken.state, {
    kind: 'Inbound',
    message: message('later', 30),
    newGenerationId: GenerationId.make('unused'),
    nextLogicalTurnId: LogicalTurnId.make('unused'),
  });
  expect(quarantined.actions).toEqual([]);
  expect(quarantined.state.pool.map(({ id }) => id)).toEqual(['already-pooled', 'later']);

  const reset = transitionScheduler(quarantined.state, {
    kind: 'Inbound',
    message: message('reset', 40, '/new'),
    newGenerationId: GenerationId.make('generation-2'),
    nextLogicalTurnId: LogicalTurnId.make('unused'),
  });
  expect(reset.state).toMatchObject({ generationBroken: false, pool: [] });
});

it('starts the first idle message immediately', () => {
  const result = transitionScheduler(idle(), {
    kind: 'Inbound',
    message: message('first', 0),
    newGenerationId: GenerationId.make('unused'),
    nextLogicalTurnId: LogicalTurnId.make('turn-1'),
  });
  expect(result.actions).toMatchObject([{ kind: 'StartTurn', logicalTurnId: 'turn-1' }]);
  expect(result.state.active?.logicalTurnId).toBe('turn-1');
});

it('pools active-turn input for three quiet seconds with a ten-second hard cap', () => {
  const active: SchedulerState = {
    ...idle(),
    active: {
      acknowledged: false,
      codexTurnId: CodexTurnId.make('codex-turn'),
      logicalTurnId: LogicalTurnId.make('turn-1'),
    },
  };
  const first = transitionScheduler(active, {
    kind: 'Inbound',
    message: message('second', 0),
    newGenerationId: GenerationId.make('unused'),
    nextLogicalTurnId: LogicalTurnId.make('unused'),
  });
  const last = transitionScheduler(first.state, {
    kind: 'Inbound',
    message: message('third', 9000),
    newGenerationId: GenerationId.make('unused'),
    nextLogicalTurnId: LogicalTurnId.make('unused'),
  });
  expect(poolDeadline(last.state.pool)).toEqual(at(10_000));
  const stale = transitionScheduler(last.state, {
    deadlineAt: at(3000),
    kind: 'PoolTimer',
    newGenerationId: GenerationId.make('unused'),
    nextLogicalTurnId: LogicalTurnId.make('unused'),
  });
  expect(stale.actions).toEqual([{ deadlineAt: at(10_000), kind: 'SchedulePool' }]);
  const flush = transitionScheduler(last.state, {
    deadlineAt: at(10_000),
    kind: 'PoolTimer',
    newGenerationId: GenerationId.make('unused'),
    nextLogicalTurnId: LogicalTurnId.make('unused'),
  });
  expect(flush.actions).toMatchObject([{ kind: 'SteerTurn', logicalTurnId: 'turn-1' }]);
  expect(flush.state.pool).toEqual([]);
});

it('keeps one acknowledgement allowance across steering', () => {
  const active: SchedulerState = {
    ...idle(),
    active: {
      acknowledged: false,
      codexTurnId: CodexTurnId.make('codex-turn'),
      logicalTurnId: LogicalTurnId.make('turn-1'),
    },
  };
  const first = transitionScheduler(active, {
    at: at(100),
    kind: 'AcknowledgementEmitted',
    logicalTurnId: LogicalTurnId.make('turn-1'),
  });
  const duplicate = transitionScheduler(first.state, {
    at: at(200),
    kind: 'AcknowledgementEmitted',
    logicalTurnId: LogicalTurnId.make('turn-1'),
  });
  expect(first.actions).toMatchObject([{ kind: 'RecordAcknowledgement' }]);
  expect(duplicate.actions).toEqual([]);
});

it('starts pooled input only after the active turn completes', () => {
  const state: SchedulerState = {
    ...idle(),
    active: {
      acknowledged: true,
      codexTurnId: CodexTurnId.make('codex-turn'),
      logicalTurnId: LogicalTurnId.make('turn-1'),
    },
    pool: [message('next', 100)],
  };
  const result = transitionScheduler(state, {
    at: at(200),
    kind: 'TurnCompleted',
    logicalTurnId: LogicalTurnId.make('turn-1'),
    newGenerationId: GenerationId.make('unused'),
    nextLogicalTurnId: LogicalTurnId.make('turn-2'),
  });
  expect(result.actions.map(({ kind }) => kind)).toEqual(['CompleteTurn', 'StartTurn']);
  expect(result.state.active?.logicalTurnId).toBe('turn-2');
});

it('rotates stale thread configuration only after its active turn terminates', () => {
  const state: SchedulerState = {
    ...idle(),
    active: {
      acknowledged: true,
      codexTurnId: CodexTurnId.make('codex-turn'),
      logicalTurnId: LogicalTurnId.make('turn-1'),
    },
    configurationCurrent: false,
    pool: [message('next', 100)],
  };
  const result = transitionScheduler(state, {
    at: at(200),
    kind: 'TurnCompleted',
    logicalTurnId: LogicalTurnId.make('turn-1'),
    newGenerationId: GenerationId.make('generation-2'),
    nextLogicalTurnId: LogicalTurnId.make('turn-2'),
  });
  expect(result.actions.map(({ kind }) => kind)).toEqual([
    'CompleteTurn',
    'RotateConfiguration',
    'StartTurn',
  ]);
  expect(result.state).toMatchObject({
    configurationCurrent: true,
    generationId: 'generation-2',
    pool: [],
  });
  expect(result.state.active?.logicalTurnId).toBe('turn-2');
});

it('preserves a pre-upgrade idle pool when its timer safely rotates configuration', () => {
  const state: SchedulerState = {
    ...idle(),
    configurationCurrent: false,
    generationBroken: true,
    pool: [message('pooled-before-upgrade', 0)],
  };
  const result = transitionScheduler(state, {
    deadlineAt: at(3000),
    kind: 'PoolTimer',
    newGenerationId: GenerationId.make('generation-2'),
    nextLogicalTurnId: LogicalTurnId.make('turn-2'),
  });
  expect(result.actions.map(({ kind }) => kind)).toEqual(['RotateConfiguration', 'StartTurn']);
  expect(result.actions.find(({ kind }) => kind === 'StartTurn')).toMatchObject({
    messages: [{ id: 'pooled-before-upgrade' }],
  });
  expect(result.state).toMatchObject({
    configurationCurrent: true,
    generationBroken: false,
    generationId: 'generation-2',
  });
});

it('/new drops pooled state and makes old-generation events inert', () => {
  const state: SchedulerState = {
    ...idle(),
    active: {
      acknowledged: false,
      codexTurnId: CodexTurnId.make('codex-turn'),
      logicalTurnId: LogicalTurnId.make('turn-1'),
    },
    pool: [message('pending', 0)],
  };
  const reset = transitionScheduler(state, {
    kind: 'Inbound',
    message: message('command', 1, '/new'),
    newGenerationId: GenerationId.make('generation-2'),
    nextLogicalTurnId: LogicalTurnId.make('unused'),
  });
  expect(reset.actions.map(({ kind }) => kind)).toEqual([
    'ResetGeneration',
    'BindThread',
    'ReplyNewChat',
  ]);
  expect(reset.state.pool).toEqual([]);
  const late = transitionScheduler(reset.state, {
    at: at(2),
    kind: 'TurnCompleted',
    logicalTurnId: LogicalTurnId.make('turn-1'),
    newGenerationId: GenerationId.make('unused'),
    nextLogicalTurnId: LogicalTurnId.make('turn-2'),
  });
  expect(late.actions).toEqual([{ event: 'TurnCompleted', kind: 'IgnoreLateEvent' }]);
});

it('/status remains local and leaves the scheduler untouched', () => {
  const state = idle();
  const result = transitionScheduler(state, {
    kind: 'Inbound',
    message: message('command', 0, '/status'),
    newGenerationId: GenerationId.make('unused'),
    nextLogicalTurnId: LogicalTurnId.make('unused'),
  });
  expect(result).toEqual({
    actions: [{ commandMessageId: 'command', kind: 'ReplyStatus' }],
    state,
  });
});
