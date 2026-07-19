import { Effect, Result } from 'effect';

import type { PendingControl } from '../journal/control-recovery';
import type { SchedulerController } from '../scheduler/controller';
import { captureAccountFailure, requestPendingAccountFailover } from './account-failover';
import { controlReplyText, report, type EngineContext } from './context';
import { ensureConversation, pollApprovalEvents } from './ingestion-phase';
import { failTurn, retryTurnTerminals } from './turn-failure';
import { recoverActive } from './turn-recovery';

const recoverControlReply = (
  context: EngineContext,
  control: PendingControl,
): Effect.Effect<void, unknown> =>
  controlReplyText(context, control.command === '/status' ? 'Status' : 'NewChat').pipe(
    Effect.flatMap((text) =>
      context.options.delivery.deliverControlMessage(control.inboundMessageId, text, context.now()),
    ),
  );

const recoverControlReplies = (context: EngineContext): Effect.Effect<void, unknown> =>
  Effect.gen(function* recoverPersistedControlReplies() {
    const controls = yield* context.journal.listPendingControls;
    for (const control of controls) {
      yield* recoverControlReply(context, control);
    }
  });

const processRecovery = (
  context: EngineContext,
  controller: SchedulerController,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* recoverEngineState() {
    if (!(yield* ensureConversation(context))) {
      return;
    }
    yield* context.journal.auditStagedAttachments;
    yield* retryTurnTerminals(context);
    if (context.recoveryPending.value) {
      yield* controller.reloadBeforeActivation(context.now());
      context.recoveryPending.value = false;
      const state = yield* controller.snapshot;
      const recovery = yield* Effect.result(recoverActive(context, controller));
      if (Result.isFailure(recovery)) {
        if (state.active === null) {
          report(context, recovery.failure);
        } else if (yield* captureAccountFailure(context, controller, recovery.failure)) {
          return;
        } else {
          yield* failTurn(
            context,
            { generationId: state.generationId, logicalTurnId: state.active.logicalTurnId },
            recovery.failure,
          );
        }
      }
    }
    yield* controller.activate;
    yield* recoverControlReplies(context);
    yield* pollApprovalEvents(context);
    yield* requestPendingAccountFailover(context, controller);
  });

export { processRecovery };
