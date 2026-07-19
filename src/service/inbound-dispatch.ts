import { randomUUID } from 'node:crypto';

import { Effect, Result } from 'effect';

import { GenerationId, LogicalTurnId } from '../domain/ids';
import type { PendingInboundMessage } from '../journal/inbound-recovery';
import type { SchedulerController } from '../scheduler/controller';
import { captureAccountFailure } from './account-failover';
import { report, type EngineContext } from './context';
import { failTurn } from './turn-failure';

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
      const state = yield* controller.snapshot;
      const nextLogicalTurnId = LogicalTurnId.make(randomUUID());
      const event = {
        kind: 'Inbound',
        message: { id: message.id, receivedAt: message.receivedAt, text: message.text },
        newGenerationId: GenerationId.make(randomUUID()),
        nextLogicalTurnId,
      } as const;
      const dispatched = yield* Effect.result(controller.dispatch(event));
      if (Result.isFailure(dispatched)) {
        if (yield* captureAccountFailure(context, controller, dispatched.failure)) {
          return;
        }
        const command = message.text.trim().toLowerCase();
        if (
          state.active === null &&
          !state.generationBroken &&
          command !== '/new' &&
          command !== '/status'
        ) {
          yield* failTurn(
            context,
            { generationId: state.generationId, logicalTurnId: nextLogicalTurnId },
            dispatched.failure,
          );
        } else {
          report(context, dispatched.failure);
        }
        return;
      }
    }
  });

export { dispatchPending };
