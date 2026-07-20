import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect, type Fiber, Result } from 'effect';

import type { ApprovalManager } from '../approval/manager';
import type { AttachmentStagingPolicy } from '../attachments/staging-policy';
import type { CodexRuntime } from '../codex/runtime';
import type { ConversationPolicy } from '../conversation-policy';
import type { DeliveryService } from '../delivery/service';
import type { ChatGuid, MessagesRowId } from '../domain/ids';
import { safeErrorDiagnostic, safeErrorTag } from '../error-message';
import {
  SpikeRuntimeError,
  type WaitingForAuthentication,
  type WaitingForCapacity,
} from '../errors';
import type { CodexJournal } from '../journal/codex-journal';
import type { SchedulerJournal } from '../journal/scheduler-journal';
import type { Journal } from '../journal/service';
import type { LikeAcknowledgement } from '../like/adapter';
import type { FailureLog } from '../logging/failure-log';
import type { MessagesInboxHandle } from '../messages-inbox';
import type { OpenMessagesWatcher } from '../messages-watcher';
import type { ScheduleJournal } from '../schedule/journal';
import type { ScheduleServerRequests } from '../schedule/server-requests';
import type { SchedulerController } from '../scheduler/controller';
import type { SchedulerEvent } from '../scheduler/model';
import type { EventLoopCounters } from './event-loop-diagnostics';
import type { TurnTerminalQueue } from './turn-terminal-model';
import type { EngineWakeHub } from './wake';

interface SpikeEngineOptions {
  readonly accountObservationIntervalMs?: number;
  readonly approvalExpiryMs?: number;
  readonly attachmentSourceRoot: string;
  readonly attachmentStagingRoot: string;
  readonly chatGuid: ChatGuid;
  readonly conversation: ConversationPolicy;
  readonly database: Database;
  readonly delivery: DeliveryService;
  readonly failureLog?: FailureLog;
  readonly handle: string;
  readonly inbox: MessagesInboxHandle;
  readonly like: LikeAcknowledgement;
  readonly messagesDebounceMs?: number;
  readonly now?: () => Date;
  readonly phaseRetryMs?: number;
  readonly reconcileIntervalMs?: number;
  readonly redactionIntervalMs?: number;
  readonly renderStatus: () => Promise<string>;
  readonly runtime: CodexRuntime;
  readonly watchMessages?: OpenMessagesWatcher;
}

type AccountFailure = WaitingForAuthentication | WaitingForCapacity;

interface EngineContext {
  readonly accountFailover: {
    pending: AccountFailure | null;
    requested: boolean;
    readonly signal: PromiseWithResolvers<AccountFailure>;
  };
  approval: ApprovalManager | null;
  readonly attachmentStaging: AttachmentStagingPolicy;
  readonly closing: { value: boolean };
  readonly codexJournal: CodexJournal;
  readonly conversationReady: { value: boolean };
  readonly controllerReady: PromiseWithResolvers<SchedulerController>;
  readonly journal: Journal;
  readonly failureLog: FailureLog;
  readonly loopDiagnostics: EventLoopCounters;
  readonly lastAccountObservationAt: { value: Date };
  readonly lastRedactionAt: { value: Date };
  readonly monitors: Map<string, Promise<void>>;
  readonly now: () => Date;
  readonly options: SpikeEngineOptions;
  readonly pendingScanFloor: { value: MessagesRowId };
  readonly recoveryPending: { value: boolean };
  readonly schedulerReady: { value: boolean };
  readonly scheduledFibers: Set<Fiber.Fiber<void, unknown>>;
  readonly schedulingClosed: { value: boolean };
  readonly schedulerJournal: SchedulerJournal;
  readonly scheduleJournal: ScheduleJournal;
  scheduleRequests: ScheduleServerRequests | null;
  readonly turnTerminals: TurnTerminalQueue;
  readonly watcherDebounceTimers: Set<ReturnType<typeof setTimeout>>;
  readonly wakes: EngineWakeHub;
}

interface FailureReportContext {
  readonly failureLog: FailureLog;
  readonly now: () => Date;
  readonly options: { readonly database: Database };
}

const statusError = (cause: unknown): SpikeRuntimeError =>
  new SpikeRuntimeError({ cause, message: safeErrorDiagnostic(cause), operation: 'status/render' });

const report = (context: FailureReportContext, error: unknown): void => {
  const at = context.now();
  const message = safeErrorDiagnostic(error);
  const tag = safeErrorTag(error);
  try {
    context.options.database.run(
      `INSERT INTO failures(correlation_id, operation, error_tag, message, details_json, created_at)
       VALUES (?, 'engine', ?, ?, NULL, ?)`,
      [randomUUID(), tag, message, at.toISOString()],
    );
  } catch {
    // The diagnostic sink below still receives the primary failure.
  }
  context.failureLog.report({ at, errorTag: tag, message, operation: 'engine' });
};

const controlReplyText = (
  context: EngineContext,
  kind: 'NewChat' | 'Status',
): Effect.Effect<string> => {
  if (kind === 'NewChat') {
    return Effect.succeed('New chat started.');
  }
  return Effect.gen(function* renderStatusReply() {
    const rendered = yield* Effect.result(
      Effect.tryPromise({ catch: statusError, try: context.options.renderStatus }),
    );
    if (Result.isSuccess(rendered)) {
      return rendered.success;
    }
    report(context, rendered.failure);
    return `Spike hit an error: ${safeErrorDiagnostic(rendered.failure)}`;
  });
};

const dispatch = async (context: EngineContext, event: SchedulerEvent): Promise<void> => {
  const controller = await context.controllerReady.promise;
  await Effect.runPromise(controller.dispatch(event));
};

export { controlReplyText, dispatch, report };
export type { AccountFailure, EngineContext, SpikeEngineOptions };
