import type { Database } from 'bun:sqlite';

import type { Effect } from 'effect';

import type { CodexRuntime } from '../codex/runtime';
import type { CodexServerRequest, JsonRpcId } from '../codex/server-request-registry';
import type { DeliveryService } from '../delivery/service';
import type { ApprovalJournal } from './journal';

interface ApprovalManager {
  readonly close: Effect.Effect<void, unknown>;
  readonly connectionId: string;
  readonly journal: ApprovalJournal;
  readonly poll: Effect.Effect<void, unknown>;
}

interface ApprovalManagerOptions {
  readonly database: Database;
  readonly delivery: DeliveryService;
  readonly expiryMs?: number;
  readonly now: () => Date;
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

export type { ApprovalContext, ApprovalEvent, ApprovalManager, ApprovalManagerOptions };
