import type { Database } from 'bun:sqlite';

import type { Effect } from 'effect';

import type { ThreadSnapshot } from '../src/codex/reconcile';
import type { CodexServerRequest, JsonRpcId } from '../src/codex/server-request-registry';
import type { ConversationPolicy } from '../src/conversation-policy';
import type { JournalHandle } from '../src/database';
import type { ObservedMessage } from '../src/domain/inbound';
import type { LikeAcknowledgement } from '../src/like/adapter';
import type { MessagesInboxHandle } from '../src/messages-inbox';
import type { OpenMessagesWatcher } from '../src/messages-watcher';
import type { SpikeEngine } from '../src/service/engine';
import type { TurnBehavior } from './fake-codex-runtime';

interface EngineFixture {
  readonly archived: string[];
  readonly attachmentInputs: string[][];
  readonly attachmentStagingRoot: string;
  readonly closeCodexConnection: () => void;
  readonly conversation: ConversationPolicy;
  readonly database: Database;
  readonly engine: SpikeEngine;
  readonly failNextInboxScans: (count?: number) => void;
  readonly handle: JournalHandle;
  readonly inputs: string[];
  readonly inboxScans: number;
  readonly interrupted: string[];
  readonly likes: string[];
  readonly push: (...messages: readonly ObservedMessage[]) => void;
  readonly reads: string[];
  readonly requestApproval: (request: CodexServerRequest) => void;
  readonly resolveServerRequest: (id: JsonRpcId) => void;
  readonly remove: () => void;
  readonly responses: { readonly id: JsonRpcId; readonly result: unknown }[];
  readonly resumed: string[];
  readonly sent: string[];
  readonly steers: string[];
  readonly turnsStarted: string[];
}

interface EngineFixtureOptions {
  readonly beforeOpen?: (databasePath: string) => void;
  readonly behavior?: TurnBehavior;
  readonly conversationProbe?: () => Effect.Effect<void, unknown>;
  readonly conversationValidationIntervalMs?: number;
  readonly idleFrontier?: number;
  readonly inbox?: MessagesInboxHandle;
  readonly inboxScanFailures?: number;
  readonly like?: LikeAcknowledgement;
  readonly messagesDebounceMs?: number;
  readonly now?: () => Date;
  readonly onInboxScan?: (scan: number) => Effect.Effect<void>;
  readonly phaseRetryMs?: number;
  readonly prepare?: (database: Database) => Effect.Effect<void, unknown>;
  readonly preexisting?: readonly ObservedMessage[];
  readonly reconcileIntervalMs?: number;
  readonly snapshot?: ThreadSnapshot;
  readonly watchMessages?: OpenMessagesWatcher;
}

export type { EngineFixture, EngineFixtureOptions };
