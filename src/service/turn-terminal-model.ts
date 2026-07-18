import type { LogicalTurnId } from '../domain/ids';
import type { SchedulerEvent, TurnIdentity } from '../scheduler/model';

type FailureTerminalEvent = Extract<
  SchedulerEvent,
  { readonly kind: 'GenerationBroken' | 'TurnFailed' }
>;

interface TurnTerminalBase {
  readonly identity: TurnIdentity;
  readonly sourceId: string;
}

interface CompletionTerminalObligation extends TurnTerminalBase {
  readonly event: Extract<SchedulerEvent, { readonly kind: 'TurnCompleted' }>;
  readonly kind: 'Completion';
}

interface FailureTerminalObligation extends TurnTerminalBase {
  readonly error: unknown;
  readonly event: FailureTerminalEvent;
  readonly kind: 'Failure';
}

type TurnTerminalObligation = CompletionTerminalObligation | FailureTerminalObligation;

interface TurnTerminalQueue {
  readonly pending: Map<LogicalTurnId, TurnTerminalObligation>;
  tail: Promise<void>;
}

const makeTurnTerminalQueue = (): TurnTerminalQueue => ({
  pending: new Map(),
  tail: Promise.resolve(),
});

export { makeTurnTerminalQueue };
export type {
  CompletionTerminalObligation,
  FailureTerminalEvent,
  FailureTerminalObligation,
  TurnTerminalObligation,
  TurnTerminalQueue,
};
