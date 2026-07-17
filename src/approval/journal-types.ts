import type { Effect } from 'effect';

import type { JsonRpcId } from '../codex/server-request-registry';
import type { ApprovalId, InboundMessageId } from '../domain/ids';
import type { JournalTransactionError } from '../errors';
import type { ApprovalRequest, ApprovalState } from './model';

interface ApprovalRecord extends ApprovalRequest {
  readonly connectionId: string;
  readonly deliveredAt: Date | null;
  readonly response: unknown;
  readonly state: ApprovalState;
}

interface ApprovalCommand {
  readonly id: InboundMessageId;
  readonly text: string;
}

type CommandResolution =
  | { readonly kind: 'Ignored' }
  | { readonly kind: 'Invalid'; readonly sourceId: InboundMessageId }
  | { readonly kind: 'NoPending'; readonly sourceId: InboundMessageId }
  | {
      readonly decision: 'no' | 'yes';
      readonly kind: 'Resolved';
      readonly record: ApprovalRecord;
      readonly sourceId: InboundMessageId;
    };

interface ApprovalCounts {
  readonly displayed: number;
  readonly orphaned: number;
  readonly pending: number;
  readonly recentlyResolved: number;
}

interface ApprovalJournal {
  readonly cancelConnection: (
    connectionId: string,
    at: Date,
  ) => Effect.Effect<readonly ApprovalRecord[], JournalTransactionError>;
  readonly counts: (now: Date) => Effect.Effect<ApprovalCounts, JournalTransactionError>;
  readonly enqueue: (
    request: ApprovalRequest,
    connectionId: string,
  ) => Effect.Effect<ApprovalRecord, JournalTransactionError>;
  readonly expireDue: (
    now: Date,
  ) => Effect.Effect<readonly ApprovalRecord[], JournalTransactionError>;
  readonly listCommands: Effect.Effect<readonly ApprovalCommand[], JournalTransactionError>;
  readonly listRecent: (
    limit: number,
  ) => Effect.Effect<readonly ApprovalRecord[], JournalTransactionError>;
  readonly markDelivered: (
    id: ApprovalId,
    at: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly markDeliveryFailed: (
    id: ApprovalId,
    error: string,
    at: Date,
  ) => Effect.Effect<ApprovalRecord | null, JournalTransactionError>;
  readonly markOrphaned: (
    connectionId: string,
    at: Date,
  ) => Effect.Effect<readonly ApprovalRecord[], JournalTransactionError>;
  readonly orphanConnection: (
    connectionId: string,
    at: Date,
  ) => Effect.Effect<readonly ApprovalRecord[], JournalTransactionError>;
  readonly markResponded: (
    id: ApprovalId,
    at: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly markResponseFailed: (
    id: ApprovalId,
    error: string,
    at: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly nextUndelivered: Effect.Effect<ApprovalRecord | null, JournalTransactionError>;
  readonly resolveCommand: (
    command: ApprovalCommand,
    at: Date,
  ) => Effect.Effect<CommandResolution, JournalTransactionError>;
  readonly resolveUpstream: (
    connectionId: string,
    rpcRequestId: JsonRpcId,
    at: Date,
  ) => Effect.Effect<ApprovalRecord | null, JournalTransactionError>;
}

export type { ApprovalCommand, ApprovalCounts, ApprovalJournal, ApprovalRecord, CommandResolution };
