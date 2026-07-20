import { Effect, Ref, Result, Semaphore } from 'effect';

import type { DeliveryError } from '../delivery/service';
import type { CodexThreadId, CodexTurnId, InboundMessageId } from '../domain/ids';
import type {
  CodexRuntimeError,
  GenerationBroken,
  JournalTransactionError,
  SpikeRuntimeError,
  WaitingForAuthentication,
  WaitingForCapacity,
} from '../errors';
import type { SchedulerJournal } from '../journal/scheduler-journal';
import type {
  PooledMessage,
  SchedulerAction,
  SchedulerEvent,
  SchedulerState,
  TurnIdentity,
} from './model';
import { ownsActiveTurn } from './ownership';
import { poolDeadline, transitionScheduler } from './transition';

type SchedulerControllerError =
  | CodexRuntimeError
  | DeliveryError
  | GenerationBroken
  | JournalTransactionError
  | SpikeRuntimeError
  | WaitingForAuthentication
  | WaitingForCapacity;

interface StartedTurn {
  readonly threadId: CodexThreadId;
  readonly turnId: CodexTurnId;
}

interface SchedulerPorts {
  readonly bindThread: () => Effect.Effect<CodexThreadId | null, SchedulerControllerError>;
  readonly cleanupGeneration: (
    previous: SchedulerState,
    kind: 'ResetGeneration' | 'RotateConfiguration',
  ) => Effect.Effect<void, SchedulerControllerError>;
  readonly replyLocal: (
    kind: 'NewChat' | 'Status',
    state: SchedulerState,
    commandMessageId: InboundMessageId,
  ) => Effect.Effect<void, SchedulerControllerError>;
  readonly reportFailure: (error: SchedulerControllerError) => Effect.Effect<void>;
  readonly schedulePool: (
    deadlineAt: Date,
    identity: TurnIdentity | null,
  ) => Effect.Effect<void, SchedulerControllerError>;
  readonly startTurn: (
    logicalTurnId: Extract<SchedulerAction, { kind: 'StartTurn' }>['logicalTurnId'],
    messages: readonly PooledMessage[],
  ) => Effect.Effect<StartedTurn, SchedulerControllerError>;
  readonly steerTurn: (
    action: Extract<SchedulerAction, { kind: 'SteerTurn' }>,
  ) => Effect.Effect<void, SchedulerControllerError>;
}

interface SchedulerController {
  readonly activate: Effect.Effect<void, SchedulerControllerError>;
  readonly dispatch: (event: SchedulerEvent) => Effect.Effect<void, SchedulerControllerError>;
  readonly reloadBeforeActivation: (now: Date) => Effect.Effect<void, JournalTransactionError>;
  readonly runIfTurnOwned: <E, R>(
    identity: TurnIdentity,
    effect: Effect.Effect<void, E, R>,
  ) => Effect.Effect<void, E, R>;
  readonly snapshot: Effect.Effect<SchedulerState>;
}

interface ActivationState {
  value: boolean;
}

const eventTime = (event: SchedulerEvent): Date => {
  if (event.kind === 'Inbound') {
    return event.message.receivedAt;
  }
  if ('at' in event) {
    return event.at;
  }
  if ('deadlineAt' in event) {
    return event.deadlineAt;
  }
  return new Date();
};

const turnIdentity = (state: SchedulerState): TurnIdentity | null =>
  state.active === null
    ? null
    : { generationId: state.generationId, logicalTurnId: state.active.logicalTurnId };

const makeTurnOwnerGuard =
  (
    state: Ref.Ref<SchedulerState>,
    semaphore: Semaphore.Semaphore,
  ): SchedulerController['runIfTurnOwned'] =>
  (identity, effect) =>
    semaphore.withPermits(1)(
      Effect.flatMap(Ref.get(state), (current) =>
        ownsActiveTurn(current, identity) ? effect : Effect.void,
      ),
    );

const runSideEffects = Effect.fn('SpikeScheduler.runSideEffects')(function* runSideEffects(
  ports: SchedulerPorts,
  previous: SchedulerState,
  next: SchedulerState,
  actions: readonly SchedulerAction[],
  applyUnlocked: (event: SchedulerEvent) => Effect.Effect<void, SchedulerControllerError>,
  now: Date,
) {
  for (const action of actions) {
    if (action.kind === 'BindThread') {
      const threadId = yield* ports.bindThread();
      if (threadId !== null) {
        yield* applyUnlocked({ codexThreadId: threadId, kind: 'ThreadBound' });
      }
    } else if (action.kind === 'SchedulePool') {
      yield* ports.schedulePool(action.deadlineAt, turnIdentity(next));
    } else if (action.kind === 'SteerTurn') {
      yield* ports.steerTurn(action);
    } else if (action.kind === 'StartTurn') {
      const started = yield* ports.startTurn(action.logicalTurnId, action.messages);
      if (next.codexThreadId !== started.threadId) {
        yield* applyUnlocked({ codexThreadId: started.threadId, kind: 'ThreadBound' });
      }
      yield* applyUnlocked({
        at: now,
        codexTurnId: started.turnId,
        kind: 'TurnStarted',
        logicalTurnId: action.logicalTurnId,
      });
    } else if (action.kind === 'ResetGeneration' || action.kind === 'RotateConfiguration') {
      const cleanup = yield* Effect.result(ports.cleanupGeneration(previous, action.kind));
      if (Result.isFailure(cleanup)) {
        yield* ports.reportFailure(cleanup.failure);
      }
    } else if (action.kind === 'ReplyNewChat') {
      yield* ports.replyLocal('NewChat', next, action.commandMessageId);
    } else if (action.kind === 'ReplyStatus') {
      yield* ports.replyLocal('Status', next, action.commandMessageId);
    }
  }
});

const makeReloadBeforeActivation =
  (
    state: Ref.Ref<SchedulerState>,
    semaphore: Semaphore.Semaphore,
    journal: SchedulerJournal,
    activation: ActivationState,
  ): SchedulerController['reloadBeforeActivation'] =>
  (now) =>
    semaphore.withPermits(1)(
      activation.value
        ? Effect.die(new Error('scheduler state cannot be reloaded after activation'))
        : journal.loadOrCreate(now).pipe(Effect.flatMap((persisted) => Ref.set(state, persisted))),
    );

const makeActivate = (
  state: Ref.Ref<SchedulerState>,
  semaphore: Semaphore.Semaphore,
  ports: SchedulerPorts,
  activation: ActivationState,
): SchedulerController['activate'] =>
  semaphore.withPermits(1)(
    Effect.gen(function* activateScheduler() {
      if (activation.value) {
        return;
      }
      const current = yield* Ref.get(state);
      const restartDeadline = poolDeadline(current.pool);
      if (restartDeadline !== null) {
        yield* ports.schedulePool(restartDeadline, turnIdentity(current));
      }
      activation.value = true;
    }),
  );

const makeSchedulerController = Effect.fn('SpikeScheduler.make')(function* makeSchedulerController(
  initial: SchedulerState,
  journal: SchedulerJournal,
  ports: SchedulerPorts,
) {
  const state = yield* Ref.make(initial);
  const semaphore = yield* Semaphore.make(1);
  const activation = { value: false };
  const applyUnlocked = (event: SchedulerEvent): Effect.Effect<void, SchedulerControllerError> =>
    Effect.gen(function* applySchedulerEvent() {
      const previous = yield* Ref.get(state);
      const transition = transitionScheduler(previous, event);
      const now = eventTime(event);
      yield* journal.commitTransition(transition, now);
      yield* Ref.set(state, transition.state);
      yield* runSideEffects(
        ports,
        previous,
        transition.state,
        transition.actions,
        applyUnlocked,
        now,
      );
    });
  const dispatch = (event: SchedulerEvent): Effect.Effect<void, SchedulerControllerError> =>
    semaphore.withPermits(1)(applyUnlocked(event));
  const reloadBeforeActivation = makeReloadBeforeActivation(state, semaphore, journal, activation);
  const runIfTurnOwned = makeTurnOwnerGuard(state, semaphore);
  const activate = makeActivate(state, semaphore, ports, activation);
  return {
    activate,
    dispatch,
    reloadBeforeActivation,
    runIfTurnOwned,
    snapshot: Ref.get(state),
  } satisfies SchedulerController;
});

export { makeSchedulerController };
export type { SchedulerController, SchedulerControllerError, SchedulerPorts, StartedTurn };
