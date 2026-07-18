import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';

import { makeApprovalJournal, type ApprovalJournal } from '../src/approval/journal';
import { decodeApprovalRequest, type ApprovalRequest } from '../src/approval/model';
import type { CodexServerRequest } from '../src/codex/server-request-registry';
import { openJournal, type JournalHandle } from '../src/database';
import { makeDeliveryJournal, type DeliveryJournal } from '../src/delivery/journal';
import {
  AccountId,
  ChatGuid,
  type CodexAttemptId,
  CodexItemId,
  CodexThreadId,
  CodexTurnId,
  InboundMessageId,
  LogicalTurnId,
  MessageGuid,
  MessagesRowId,
} from '../src/domain/ids';
import type { ObservedMessage } from '../src/domain/inbound';
import { makeCodexJournal, type CodexJournal } from '../src/journal/codex-journal';
import { makeSchedulerJournal, type SchedulerJournal } from '../src/journal/scheduler-journal';
import { makeJournal, type Journal } from '../src/journal/service';
import type { PooledMessage, SchedulerState } from '../src/scheduler/model';

interface RetentionFixture {
  readonly approvals: ApprovalJournal;
  readonly close: () => void;
  readonly codex: CodexJournal;
  readonly database: Database;
  readonly delivery: DeliveryJournal;
  readonly handle: JournalHandle;
  readonly journal: Journal;
  readonly scheduler: SchedulerJournal;
  readonly state: SchedulerState;
}

interface StartedRetentionTurn {
  readonly attemptId: CodexAttemptId;
  readonly logicalTurnId: LogicalTurnId;
}

const CHAT_GUID = ChatGuid.make('any;-;+15555550199');
const HANDLE = '+15555550199';
const OLD = new Date('2026-06-01T12:00:00.000Z');
const NOW = new Date('2026-07-15T12:00:00.000Z');
const CUTOFF = new Date('2026-06-15T12:00:00.000Z');
const APPROVAL_EXPIRY_MS = 600_000;

const makeRetentionFixture = Effect.fn('Test.makeRetentionFixture')(function* makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-retention-'));
  const handle = yield* openJournal(path.join(root, 'spike.db'));
  const scheduler = makeSchedulerJournal(handle.database);
  return {
    approvals: makeApprovalJournal(handle.database),
    close: (): void => {
      handle.close();
      rmSync(root, { force: true, recursive: true });
    },
    codex: makeCodexJournal(handle.database),
    database: handle.database,
    delivery: makeDeliveryJournal(handle.database),
    handle,
    journal: makeJournal(handle.database, { chatGuid: CHAT_GUID, handle: HANDLE }),
    scheduler,
    state: yield* scheduler.loadOrCreate(OLD),
  } satisfies RetentionFixture;
});

const ingest = Effect.fn('Test.ingestRetentionMessage')(function* ingestMessage(
  fixture: RetentionFixture,
  rowId: number,
  text: string,
  attachments: ObservedMessage['attachments'] = [],
) {
  const messageGuid = MessageGuid.make(`retention-${String(rowId)}`);
  const inserted = yield* fixture.journal.ingestObservedMessages(CHAT_GUID, OLD, [
    {
      attachments,
      chatGuid: CHAT_GUID,
      handle: HANDLE,
      isFromMe: false,
      messageGuid,
      rowId: MessagesRowId.make(rowId),
      sentAt: OLD,
      service: 'iMessage',
      text,
    },
  ]);
  const persisted = (yield* fixture.journal.listInbound).find(
    (message) => message.messageGuid === messageGuid,
  );
  if (persisted === undefined) {
    throw new Error(`retention message ${String(rowId)} was not persisted`);
  }
  return {
    id: InboundMessageId.make(persisted.id),
    inserted,
    receivedAt: OLD,
    text,
  } satisfies PooledMessage & { readonly inserted: number };
});

const startCodexTurn = Effect.fn('Test.startRetentionTurn')(function* startTurn(
  fixture: RetentionFixture,
  suffix: string,
  message: PooledMessage,
) {
  const logicalTurnId = LogicalTurnId.make(`logical-${suffix}`);
  yield* fixture.scheduler.beginTurn(fixture.state.generationId, logicalTurnId, [message], OLD);
  const attemptId = yield* fixture.codex.beginCodexAttempt({
    accountId: AccountId.make('default'),
    fingerprint: `fingerprint-${suffix}`,
    frontier: { itemIds: [], turnIds: [] },
    logicalTurnId,
    startedAt: OLD,
    submissionKind: 'Start',
  });
  yield* fixture.codex.acceptCodexTurn(
    attemptId,
    CodexThreadId.make(`thread-${suffix}`),
    CodexTurnId.make(`codex-turn-${suffix}`),
  );
  yield* fixture.codex.recordAgentItem(
    attemptId,
    CodexItemId.make(`item-${suffix}`),
    'agentMessage',
    { text: `${suffix} agent payload` },
    OLD,
  );
  return { attemptId, logicalTurnId };
});

const commandRequest = (id: number, command: string): CodexServerRequest => ({
  id,
  method: 'item/commandExecution/requestApproval',
  params: {
    availableDecisions: ['accept', 'decline'],
    command,
    cwd: '/private/workspace',
    itemId: `approval-item-${String(id)}`,
    reason: 'private reason',
    startedAtMs: OLD.getTime(),
    threadId: 'approval-thread',
    turnId: 'approval-turn',
  },
});

const approvalRequest = (id: number, command: string): ApprovalRequest => {
  const decoded = decodeApprovalRequest(
    commandRequest(id, command),
    OLD,
    new Date(OLD.getTime() + APPROVAL_EXPIRY_MS),
  );
  if (!decoded.valid) {
    throw new Error('retention approval request did not decode');
  }
  return decoded.request;
};

const fileApprovalRequest = (id: number): ApprovalRequest => {
  const decoded = decodeApprovalRequest(
    {
      id,
      method: 'applyPatchApproval',
      params: {
        callId: `patch-${String(id)}`,
        conversationId: 'approval-thread',
        fileChanges: { '/private/workspace/secret.ts': { type: 'update' } },
        grantRoot: '/private/workspace',
        reason: 'private patch reason',
      },
    },
    OLD,
    new Date(OLD.getTime() + APPROVAL_EXPIRY_MS),
  );
  if (!decoded.valid) {
    throw new Error('retention file approval request did not decode');
  }
  return decoded.request;
};

export {
  approvalRequest,
  CUTOFF,
  fileApprovalRequest,
  ingest,
  makeRetentionFixture,
  NOW,
  OLD,
  startCodexTurn,
};
export type { RetentionFixture, StartedRetentionTurn };
