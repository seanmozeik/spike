import type { Database } from 'bun:sqlite';

import type { Effect } from 'effect';

import type { CodexRuntime } from '../codex/runtime';
import type { CodexServerRequest, JsonRpcId } from '../codex/server-request-registry';
import type { DeliveryService } from '../delivery/service';
import type { MessagesRowId } from '../domain/ids';
import type { ApprovalJournal } from './journal';

interface ApprovalPollResult {
  readonly nextExpiryAt: Date | null;
}

interface ApprovalManager {
  readonly close: Effect.Effect<void, unknown>;
  readonly connectionId: string;
  readonly journal: ApprovalJournal;
  readonly poll: Effect.Effect<ApprovalPollResult, unknown>;
  readonly pollCommands: (
    after: MessagesRowId,
    through: MessagesRowId,
  ) => Effect.Effect<number, unknown>;
}

interface ApprovalManagerOptions {
  readonly database: Database;
  readonly delivery: DeliveryService;
  readonly expiryMs?: number;
  readonly now: () => Date;
  readonly onWake?: () => void;
  readonly runtime: CodexRuntime;
}

type ApprovalEvent =
  | { readonly kind: 'ConnectionClosed' }
  | { readonly kind: 'Request'; readonly request: CodexServerRequest }
  | { readonly id: JsonRpcId; readonly kind: 'Resolved' };

interface ApprovalContext {
  readonly connectionId: string;
  readonly expiryMs: number;
  readonly isClosed: () => boolean;
  readonly journal: ApprovalJournal;
  readonly options: ApprovalManagerOptions;
  readonly pendingEvents: ApprovalEvent[];
}

export type {
  ApprovalContext,
  ApprovalEvent,
  ApprovalManager,
  ApprovalManagerOptions,
  ApprovalPollResult,
};
