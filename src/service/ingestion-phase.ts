import { randomUUID } from 'node:crypto';

import { Effect, Result } from 'effect';

import { parseControlCommand } from '../domain/control-command';
import {
  GenerationId,
  type InboundMessageId,
  LogicalTurnId,
  type MessagesRowId,
} from '../domain/ids';
import { SpikeRuntimeError } from '../errors';
import type { PendingInboundMessage } from '../journal/inbound-recovery';
import type { SchedulerController } from '../scheduler/controller';
import type { SchedulerEvent } from '../scheduler/model';
import { captureAccountFailure, requestPendingAccountFailover } from './account-failover';
import { report, type EngineContext } from './context';
import { initializeConversation } from './conversation-lifecycle';
import { mark } from './event-loop-diagnostics';
import { pollInbox } from './inbox-poll';
import { failTurn } from './turn-failure';

const APPROVAL_EXPIRY_TIMER = 'approval-expiry';
const MAX_CONFIRMATION_PASSES = 3;

interface DispatchFailure {
  readonly error: unknown;
}

const phaseError = (operation: string, cause: unknown): SpikeRuntimeError =>
  new SpikeRuntimeError({
    cause,
    message: `event-driven engine phase failed: ${operation}`,
    operation,
  });

const runLike = (
  context: EngineContext,
  id: InboundMessageId,
  text: string,
  at: Date,
): Effect.Effect<void> =>
  Effect.forkDetach(context.options.like.acknowledge(id, text, at), {
    startImmediately: true,
  }).pipe(Effect.asVoid);

const dispatchPending = (
  context: EngineContext,
  controller: SchedulerController,
  messages: readonly PendingInboundMessage[],
  at: Date,
): Effect.Effect<DispatchFailure | null, unknown> =>
  Effect.gen(function* dispatchMessages() {
    for (const message of messages) {
      if (message.acknowledgementText !== null) {
        yield* runLike(context, message.id, message.acknowledgementText, at);
      }
      const state = yield* controller.snapshot;
      const nextLogicalTurnId = LogicalTurnId.make(randomUUID());
      const event = {
        kind: 'Inbound',
        message: {
          attachments: message.attachments,
          id: message.id,
          receivedAt: message.receivedAt,
          text: message.text,
        },
        newGenerationId: GenerationId.make(randomUUID()),
        nextLogicalTurnId,
      } satisfies Extract<SchedulerEvent, { readonly kind: 'Inbound' }>;
      const dispatched = yield* Effect.result(controller.dispatch(event));
      if (Result.isFailure(dispatched)) {
        if (yield* captureAccountFailure(context, controller, dispatched.failure)) {
          return { error: dispatched.failure };
        }
        const command = parseControlCommand(message.text);
        if (state.active === null && !state.generationBroken && command === null) {
          yield* failTurn(
            context,
            { generationId: state.generationId, logicalTurnId: nextLogicalTurnId },
            dispatched.failure,
          );
        } else {
          report(context, dispatched.failure);
          context.wakes.signal('Recovery');
        }
        return { error: dispatched.failure };
      }
    }
    return null;
  });

const scheduleApprovalExpiry = (
  context: EngineContext,
  nextExpiryAt: Date | null,
): Effect.Effect<void> => {
  if (nextExpiryAt === null) {
    return context.wakes.cancel(APPROVAL_EXPIRY_TIMER);
  }
  return context.wakes.scheduleAfter(
    APPROVAL_EXPIRY_TIMER,
    'Approval',
    nextExpiryAt.getTime() - context.now().getTime(),
  );
};

const pollApprovalEvents = (context: EngineContext): Effect.Effect<void, unknown> =>
  Effect.gen(function* pollApprovalEventQueue() {
    if (context.approval === null) {
      yield* context.wakes.cancel(APPROVAL_EXPIRY_TIMER);
      return;
    }
    const result = yield* context.approval.poll;
    yield* scheduleApprovalExpiry(context, result.nextExpiryAt);
  });

const processApprovalCommandsThrough = (
  context: EngineContext,
  candidateFrontier: MessagesRowId,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* processApprovalCommands() {
    if (context.approval === null) {
      return yield* Effect.void;
    }
    const after = context.pendingScanFloor.value;
    for (let pass = 0; pass < MAX_CONFIRMATION_PASSES; pass += 1) {
      if ((yield* context.approval.pollCommands(after, candidateFrontier)) === 0) {
        return yield* Effect.void;
      }
    }
    return yield* phaseError(
      'ingestion/approval-confirm',
      new Error(`unclaimed approval commands remained through row ${candidateFrontier}`),
    );
  });

const processTrustedControlsThrough = (
  context: EngineContext,
  controller: SchedulerController,
  candidateFrontier: MessagesRowId,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* processTrustedControls() {
    const after = context.pendingScanFloor.value;
    if (candidateFrontier <= after) {
      return yield* Effect.void;
    }
    for (let pass = 0; pass < MAX_CONFIRMATION_PASSES; pass += 1) {
      const pending = yield* context.journal.listPendingInbound(after, candidateFrontier);
      if (pending.controls.length === 0) {
        return yield* Effect.void;
      }
      const dispatchFailure = yield* dispatchPending(
        context,
        controller,
        pending.controls,
        context.now(),
      );
      if (dispatchFailure !== null) {
        return yield* phaseError('ingestion/control-dispatch', dispatchFailure.error);
      }
    }
    return yield* phaseError(
      'ingestion/control-confirm',
      new Error(`unclaimed trusted commands remained through row ${candidateFrontier}`),
    );
  });

const processUnclaimedThrough = (
  context: EngineContext,
  controller: SchedulerController,
  candidateFrontier: MessagesRowId,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* processUnclaimedMessages() {
    const after = context.pendingScanFloor.value;
    if (candidateFrontier <= after) {
      return yield* Effect.void;
    }
    for (let pass = 0; pass < MAX_CONFIRMATION_PASSES; pass += 1) {
      const pending = yield* context.journal.listPendingInbound(after, candidateFrontier);
      if (pending.messages.length === 0) {
        if (!pending.blocked) {
          context.pendingScanFloor.value = candidateFrontier;
        }
        return yield* Effect.void;
      }
      const dispatchFailure = yield* dispatchPending(
        context,
        controller,
        pending.messages,
        context.now(),
      );
      if (dispatchFailure !== null) {
        return yield* phaseError('ingestion/dispatch', dispatchFailure.error);
      }
      if (pending.blocked) {
        return yield* Effect.void;
      }
    }
    return yield* phaseError(
      'ingestion/confirm',
      new Error(`unclaimed messages remained through row ${candidateFrontier}`),
    );
  });

const ensureConversation = (context: EngineContext): Effect.Effect<boolean, unknown> =>
  Effect.gen(function* ensureConfiguredConversation() {
    if (!(yield* context.options.conversation.revalidateIfDue(context.now()))) {
      return false;
    }
    yield* initializeConversation(context);
    return true;
  });

const prepareIngestion = (
  context: EngineContext,
  controller: SchedulerController,
): Effect.Effect<MessagesRowId | null, unknown> =>
  Effect.gen(function* prepareMessagesIngestion() {
    mark(context.loopDiagnostics.ingestionPasses, context.now());
    if (!(yield* ensureConversation(context))) {
      return null;
    }
    const candidateFrontier = yield* pollInbox(context);
    yield* pollApprovalEvents(context);
    if (yield* requestPendingAccountFailover(context, controller)) {
      return null;
    }
    yield* processApprovalCommandsThrough(context, candidateFrontier);
    return candidateFrontier;
  });

const processTrustedIngestion = (
  context: EngineContext,
  controller: SchedulerController,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* processTrustedMessages() {
    const candidateFrontier = yield* prepareIngestion(context, controller);
    if (candidateFrontier !== null) {
      const staging = yield* Effect.result(context.attachmentStaging.stageIfDue(context.now()));
      if (Result.isFailure(staging)) {
        report(context, staging.failure);
      }
      yield* processTrustedControlsThrough(context, controller, candidateFrontier);
    }
  });

const processIngestion = (
  context: EngineContext,
  controller: SchedulerController,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* processMessagesIngestion() {
    const candidateFrontier = yield* prepareIngestion(context, controller);
    if (candidateFrontier === null) {
      return yield* Effect.void;
    }
    const staging = yield* Effect.result(context.attachmentStaging.stageIfDue(context.now()));
    if (Result.isFailure(staging)) {
      yield* processTrustedControlsThrough(context, controller, candidateFrontier);
      return yield* staging.failure;
    }
    const audit = yield* Effect.result(context.journal.auditStagedAttachments);
    if (Result.isFailure(audit)) {
      yield* processTrustedControlsThrough(context, controller, candidateFrontier);
      return yield* audit.failure;
    }
    return yield* processUnclaimedThrough(context, controller, candidateFrontier);
  });

export { ensureConversation, pollApprovalEvents, processIngestion, processTrustedIngestion };
