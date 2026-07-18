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
  readonly dispatch: (event: SchedulerEvent) => Effect.Effect<void, SchedulerControllerError>;
  readonly snapshot: Effect.Effect<SchedulerState>;
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
    } else if (action.kind === 'ResetGeneration') {
      const cleanup = yield* Effect.result(ports.cleanupGeneration(previous));
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

const makeSchedulerController = Effect.fn('SpikeScheduler.make')(function* makeSchedulerController(
  initial: SchedulerState,
  journal: SchedulerJournal,
  ports: SchedulerPorts,
) {
  const state = yield* Ref.make(initial);
  const semaphore = yield* Semaphore.make(1);
  const restartDeadline = poolDeadline(initial.pool);
  if (restartDeadline !== null) {
    yield* ports.schedulePool(restartDeadline, turnIdentity(initial));
  }
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
  return { dispatch, snapshot: Ref.get(state) } satisfies SchedulerController;
});

export { makeSchedulerController };
export type { SchedulerController, SchedulerControllerError, SchedulerPorts, StartedTurn };
