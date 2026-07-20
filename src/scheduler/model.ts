import type { StagedImageAttachment } from '../attachments/model';
import type {
  CodexThreadId,
  CodexTurnId,
  GenerationId,
  InboundMessageId,
  LogicalTurnId,
} from '../domain/ids';
import type { ScheduleId } from '../schedule/model';

interface PooledMessage {
  readonly attachments: readonly StagedImageAttachment[];
  readonly id: InboundMessageId;
  readonly receivedAt: Date;
  readonly text: string;
}

interface ActiveTurn {
  readonly acknowledged: boolean;
  readonly codexTurnId: CodexTurnId | null;
  readonly logicalTurnId: LogicalTurnId;
}

interface TurnIdentity {
  readonly generationId: GenerationId;
  readonly logicalTurnId: LogicalTurnId;
}

interface SchedulerState {
  readonly active: ActiveTurn | null;
  readonly codexThreadId: CodexThreadId | null;
  readonly configurationCurrent: boolean;
  readonly generationBroken: boolean;
  readonly generationId: GenerationId;
  readonly pool: readonly PooledMessage[];
}

type SchedulerEvent =
  | {
      readonly kind: 'Inbound';
      readonly message: PooledMessage;
      readonly newGenerationId: GenerationId;
      readonly nextLogicalTurnId: LogicalTurnId;
    }
  | {
      readonly expectedDueAt: Date;
      readonly expectedRevision: number;
      readonly kind: 'ScheduleDue';
      readonly message: PooledMessage;
      readonly nextDueAt: Date | null;
      readonly nextLogicalTurnId: LogicalTurnId;
      readonly newGenerationId: GenerationId;
      readonly runId: string;
      readonly scheduleId: ScheduleId;
      readonly scheduledFor: Date;
    }
  | {
      readonly deadlineAt: Date;
      readonly kind: 'PoolTimer';
      readonly newGenerationId: GenerationId;
      readonly nextLogicalTurnId: LogicalTurnId;
    }
  | {
      readonly at: Date;
      readonly codexTurnId: CodexTurnId;
      readonly kind: 'TurnStarted';
      readonly logicalTurnId: LogicalTurnId;
    }
  | {
      readonly at: Date;
      readonly kind: 'TurnCompleted';
      readonly logicalTurnId: LogicalTurnId;
      readonly newGenerationId: GenerationId;
      readonly nextLogicalTurnId: LogicalTurnId;
    }
  | {
      readonly at: Date;
      readonly kind: 'TurnFailed';
      readonly logicalTurnId: LogicalTurnId;
      readonly newGenerationId: GenerationId;
      readonly nextLogicalTurnId: LogicalTurnId;
    }
  | {
      readonly at: Date;
      readonly kind: 'GenerationBroken';
      readonly logicalTurnId: LogicalTurnId;
      readonly newGenerationId: GenerationId;
      readonly nextLogicalTurnId: LogicalTurnId;
    }
  | {
      readonly at: Date;
      readonly kind: 'AcknowledgementEmitted';
      readonly logicalTurnId: LogicalTurnId;
    }
  | { readonly codexThreadId: CodexThreadId; readonly kind: 'ThreadBound' };

type SchedulerAction =
  | { readonly kind: 'BindThread' }
  | {
      readonly expectedDueAt: Date;
      readonly expectedRevision: number;
      readonly kind: 'ClaimSchedule';
      readonly message: PooledMessage;
      readonly nextDueAt: Date | null;
      readonly runId: string;
      readonly scheduleId: ScheduleId;
      readonly scheduledFor: Date;
    }
  | {
      readonly kind: 'RotateConfiguration';
      readonly newGenerationId: GenerationId;
      readonly oldGenerationId: GenerationId;
    }
  | {
      readonly kind: 'StartTurn';
      readonly logicalTurnId: LogicalTurnId;
      readonly messages: readonly PooledMessage[];
    }
  | {
      readonly codexTurnId: CodexTurnId;
      readonly kind: 'SteerTurn';
      readonly logicalTurnId: LogicalTurnId;
      readonly messages: readonly PooledMessage[];
    }
  | { readonly deadlineAt: Date; readonly kind: 'SchedulePool' }
  | { readonly kind: 'CompleteTurn'; readonly logicalTurnId: LogicalTurnId }
  | { readonly kind: 'FailTurn'; readonly logicalTurnId: LogicalTurnId }
  | {
      readonly at: Date;
      readonly kind: 'RecordAcknowledgement';
      readonly logicalTurnId: LogicalTurnId;
    }
  | {
      readonly commandMessageId: InboundMessageId;
      readonly kind: 'ResetGeneration';
      readonly newGenerationId: GenerationId;
      readonly oldGenerationId: GenerationId;
    }
  | { readonly commandMessageId: InboundMessageId; readonly kind: 'ReplyNewChat' }
  | { readonly commandMessageId: InboundMessageId; readonly kind: 'ReplyStatus' }
  | { readonly event: SchedulerEvent['kind']; readonly kind: 'IgnoreLateEvent' };

interface SchedulerTransition {
  readonly actions: readonly SchedulerAction[];
  readonly state: SchedulerState;
}

export type {
  ActiveTurn,
  PooledMessage,
  SchedulerAction,
  SchedulerEvent,
  SchedulerState,
  SchedulerTransition,
  TurnIdentity,
};
