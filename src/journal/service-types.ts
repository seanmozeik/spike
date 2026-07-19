import type { Effect } from 'effect';

import type { AttachmentStagingPermissionError } from '../attachments/errors';
import type { ChatGuid, MessagesRowId } from '../domain/ids';
import type { ObservedMessage } from '../domain/inbound';
import type { JournalTransactionError } from '../errors';
import type { AttachmentStagingOptions } from './attachment-staging';
import type { PendingControl } from './control-recovery';
import type { PendingInboundMessage } from './inbound-recovery';

interface InboxCursor {
  readonly chatGuid: string;
  readonly lastMessageGuid: null | string;
  readonly lastRowId: number;
  readonly updatedAt: string;
}

interface PersistedInboundMessage {
  readonly id: string;
  readonly messageGuid: string;
  readonly rowId: number;
  readonly text: null | string;
}

interface Journal {
  readonly auditStagedAttachments: Effect.Effect<number, JournalTransactionError>;
  readonly advanceInboxCursor: (
    chatGuid: ChatGuid,
    frontier: MessagesRowId,
    advancedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly ingestObservedMessages: (
    chatGuid: ChatGuid,
    observedAt: Date,
    messages: readonly ObservedMessage[],
  ) => Effect.Effect<number, JournalTransactionError>;
  readonly inboxCursor: (chatGuid: ChatGuid) => Effect.Effect<InboxCursor | null>;
  readonly initializeInboxCursor: (
    chatGuid: ChatGuid,
    frontier: MessagesRowId,
    initializedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly listInbound: Effect.Effect<readonly PersistedInboundMessage[]>;
  readonly listPendingControls: Effect.Effect<readonly PendingControl[], JournalTransactionError>;
  readonly listPendingInbound: Effect.Effect<
    readonly PendingInboundMessage[],
    JournalTransactionError
  >;
  readonly redactTerminalPayloads: (
    cutoff: Date,
    redactedAt: Date,
  ) => Effect.Effect<number, JournalTransactionError>;
  readonly stagePendingAttachments: Effect.Effect<
    number,
    AttachmentStagingPermissionError | JournalTransactionError
  >;
}

interface JournalOptions {
  readonly attachmentStaging?: AttachmentStagingOptions;
}

export type { InboxCursor, Journal, JournalOptions, PersistedInboundMessage };
