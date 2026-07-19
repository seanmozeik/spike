import { randomUUID } from 'node:crypto';

import { Effect, Result } from 'effect';

import { GenerationId, LogicalTurnId } from '../domain/ids';
import type { PendingInboundMessage } from '../journal/inbound-recovery';
import type { SchedulerController } from '../scheduler/controller';
import type { SchedulerEvent } from '../scheduler/model';
import { captureAccountFailure } from './account-failover';
import type { EngineContext } from './context';
import { repairDispatchFailure } from './dispatch-repair';

const inboundEvent = (
  message: PendingInboundMessage,
  nextLogicalTurnId: ReturnType<typeof LogicalTurnId.make>,
): Extract<SchedulerEvent, { readonly kind: 'Inbound' }> => ({
  kind: 'Inbound',
  message: {
    attachments: message.attachments,
    id: message.id,
    receivedAt: message.receivedAt,
    text: message.text,
  },
  newGenerationId: GenerationId.make(randomUUID()),
  nextLogicalTurnId,
});

const dispatchPending = (
  context: EngineContext,
  controller: SchedulerController,
  messages: readonly PendingInboundMessage[],
  at: Date,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* dispatchMessages() {
    for (const message of messages) {
      if (message.acknowledgementText !== null) {
        yield* Effect.forkDetach(
          context.options.like.acknowledge(message.id, message.acknowledgementText, at),
          { startImmediately: true },
        ).pipe(Effect.asVoid);
      }
      const nextLogicalTurnId = LogicalTurnId.make(randomUUID());
      const dispatched = yield* Effect.result(
        controller.dispatch(inboundEvent(message, nextLogicalTurnId)),
      );
      if (Result.isFailure(dispatched)) {
        if (yield* captureAccountFailure(context, controller, dispatched.failure)) {
          return;
        }
        yield* repairDispatchFailure(
          context,
          yield* controller.snapshot,
          nextLogicalTurnId,
          null,
          dispatched.failure,
        );
        return;
      }
    }
  });

export { dispatchPending };
