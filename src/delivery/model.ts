import type { Effect } from 'effect';

import type {
  DeliveryAttemptId,
  LogicalTurnId,
  OutageEpisodeId,
  OutboundChunkId,
  OutboundMessageId,
} from '../domain/ids';
import type { JournalTransactionError } from '../errors';

type AssistantMessageKind = 'Final' | 'WorkAck';
type DeliveryMessageKind = AssistantMessageKind | 'OutageNotice';

interface DeliveryChunk {
  readonly attemptId: DeliveryAttemptId | null;
  readonly attemptNumber: number;
  readonly frontierRowId: number | null;
  readonly id: OutboundChunkId;
  readonly ordinal: number;
  readonly outboundMessageId: OutboundMessageId;
  readonly state: 'Failed' | 'Prepared' | 'Reconciled' | 'Sent';
  readonly text: string;
}

interface PreparedDelivery {
  readonly chunks: readonly DeliveryChunk[];
  readonly id: OutboundMessageId;
  readonly kind: DeliveryMessageKind;
}

interface DeliveryJournal {
  readonly claimAttempt: (
    chunkId: OutboundChunkId,
    frontierRowId: number,
    startedAt: Date,
  ) => Effect.Effect<DeliveryAttemptId | null, JournalTransactionError>;
  readonly listRecoverable: Effect.Effect<readonly DeliveryChunk[], JournalTransactionError>;
  readonly markAttemptUnknown: (
    attemptId: DeliveryAttemptId,
    error: string,
    finishedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly markFailed: (
    chunkId: OutboundChunkId,
    error: string,
    finishedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly markReconciled: (
    attemptId: DeliveryAttemptId,
    chunkId: OutboundChunkId,
    messageRowId: number,
    messageGuid: string,
    finishedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly markSent: (
    attemptId: DeliveryAttemptId,
    chunkId: OutboundChunkId,
    finishedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly prepareAssistantMessage: (
    logicalTurnId: LogicalTurnId,
    sourceId: string,
    kind: AssistantMessageKind,
    text: string,
    createdAt: Date,
  ) => Effect.Effect<PreparedDelivery, JournalTransactionError>;
  readonly prepareFailureNotice: (
    logicalTurnId: LogicalTurnId,
    text: string,
    createdAt: Date,
  ) => Effect.Effect<PreparedDelivery, JournalTransactionError>;
  readonly prepareControlMessage: (
    sourceId: string,
    text: string,
    createdAt: Date,
  ) => Effect.Effect<PreparedDelivery, JournalTransactionError>;
  readonly prepareOutageNotice: (
    outageEpisodeId: OutageEpisodeId,
    text: string,
    createdAt: Date,
  ) => Effect.Effect<PreparedDelivery, JournalTransactionError>;
}

export type {
  AssistantMessageKind,
  DeliveryChunk,
  DeliveryJournal,
  DeliveryMessageKind,
  PreparedDelivery,
};
