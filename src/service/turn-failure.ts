import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import { compactError } from '../delivery/service';
import { type LogicalTurnId, LogicalTurnId as LogicalTurnIdSchema } from '../domain/ids';
import { dispatch, report, type EngineContext } from './context';

const deliverFailure = async (
  context: EngineContext,
  logicalTurnId: LogicalTurnId,
  sourceId: string,
  error: unknown,
): Promise<void> => {
  report(context, error);
  await Effect.runPromise(
    context.options.delivery.deliverAssistantMessage(
      logicalTurnId,
      sourceId,
      'Final',
      `Spike hit an error: ${compactError(error)}`,
      context.now(),
    ),
  );
};

const finishFailedTurn = async (
  context: EngineContext,
  logicalTurnId: LogicalTurnId,
  sourceId: string,
  error: unknown,
): Promise<void> => {
  try {
    await deliverFailure(context, logicalTurnId, sourceId, error);
  } catch (deliveryError) {
    report(context, deliveryError);
  }
  await dispatch(context, {
    at: context.now(),
    kind: 'TurnFailed',
    logicalTurnId,
    nextLogicalTurnId: LogicalTurnIdSchema.make(randomUUID()),
  });
};

const finishBrokenGeneration = async (
  context: EngineContext,
  logicalTurnId: LogicalTurnId,
  sourceId: string,
  error: unknown,
): Promise<void> => {
  try {
    await deliverFailure(context, logicalTurnId, sourceId, error);
  } catch (deliveryError) {
    report(context, deliveryError);
  }
  await dispatch(context, { at: context.now(), kind: 'GenerationBroken', logicalTurnId });
};

export { finishBrokenGeneration, finishFailedTurn };
