import { Effect, Result } from 'effect';

import type { DeliveryAttemptId, LogicalTurnId, OutageEpisodeId } from '../domain/ids';
import { safeErrorDiagnostic } from '../error-message';
import type { JournalTransactionError } from '../errors';
import { MessagesDeliveryError } from './error';
import type { DeliveryReceipt, MessagesTransport } from './messages-transport';
import type { DeliveryChunk, DeliveryJournal, PreparedDelivery, PreparedTurnNotice } from './model';

type DeliveryError = JournalTransactionError | MessagesDeliveryError;

interface DeliveryService {
  readonly deliverPreparedTurnNotice: (
    prepared: PreparedTurnNotice,
  ) => Effect.Effect<void, DeliveryError>;
  readonly deliverFailureNotice: (
    logicalTurnId: LogicalTurnId,
    text: string,
    createdAt: Date,
  ) => Effect.Effect<void, DeliveryError>;
  readonly recover: Effect.Effect<void, DeliveryError>;
  readonly deliverOutageNotice: (
    outageEpisodeId: OutageEpisodeId,
    text: string,
    createdAt: Date,
  ) => Effect.Effect<void, DeliveryError>;
  readonly deliverControlMessage: (
    sourceId: string,
    text: string,
    createdAt: Date,
  ) => Effect.Effect<void, DeliveryError>;
  readonly prepareTurnNotice: DeliveryJournal['prepareTurnNotice'];
}

const CONFIRMATION_POLLS = 20;

const confirmationTimeout = (): MessagesDeliveryError =>
  new MessagesDeliveryError({
    cause: new Error('outbound row did not appear before confirmation timeout'),
    message: 'Messages delivery could not be confirmed',
    operation: 'confirm',
  });

const findWithPolling = Effect.fn('SpikeDelivery.confirm')(function* findWithPolling(
  transport: MessagesTransport,
  frontierRowId: number,
  text: string,
  polls = CONFIRMATION_POLLS,
) {
  for (let index = 0; index < polls; index += 1) {
    const receipt = yield* transport.findMatchingAfter(frontierRowId, text);
    if (receipt !== null) {
      return receipt;
    }
    yield* Effect.sleep('250 millis');
  }
  return null;
});

const reconcileExisting = Effect.fn('SpikeDelivery.reconcileExisting')(function* reconcileExisting(
  journal: DeliveryJournal,
  transport: MessagesTransport,
  chunk: DeliveryChunk,
) {
  if (chunk.attemptId === null || chunk.frontierRowId === null) {
    return false;
  }
  const receipt = yield* transport.findMatchingAfter(chunk.frontierRowId, chunk.text);
  if (receipt === null) {
    return false;
  }
  yield* journal.markReconciled(chunk.attemptId, chunk.id, receipt.rowId, receipt.guid, new Date());
  return true;
});

const markReceipt = (
  journal: DeliveryJournal,
  chunk: DeliveryChunk,
  attemptId: DeliveryAttemptId,
  receipt: DeliveryReceipt,
): Effect.Effect<void, JournalTransactionError> =>
  journal.markReconciled(attemptId, chunk.id, receipt.rowId, receipt.guid, new Date());

const terminalizeChunk = (
  journal: DeliveryJournal,
  chunk: DeliveryChunk,
  error: MessagesDeliveryError,
): Effect.Effect<never, JournalTransactionError | MessagesDeliveryError> =>
  journal
    .markFailed(chunk.id, safeErrorDiagnostic(error), new Date())
    .pipe(Effect.andThen(Effect.fail(error)));

const deliverChunk = (
  journal: DeliveryJournal,
  transport: MessagesTransport,
  chunk: DeliveryChunk,
  claimAttempt: DeliveryJournal['claimAttempt'] = journal.claimAttempt,
): Effect.Effect<void, DeliveryError> => {
  let attemptStarted = chunk.attemptId !== null;
  const delivery = Effect.gen(function* deliverChunkEffect() {
    if (yield* reconcileExisting(journal, transport, chunk)) {
      return yield* Effect.void;
    }
    if (chunk.attemptId !== null) {
      yield* journal.markFailed(
        chunk.id,
        'previous delivery attempt could not be confirmed',
        new Date(),
      );
      return yield* confirmationTimeout();
    }
    const frontierRowId = yield* transport.frontier;
    const attemptId = yield* claimAttempt(chunk.id, frontierRowId, new Date());
    if (attemptId === null) {
      return yield* Effect.void;
    }
    attemptStarted = true;
    const sent = yield* Effect.result(transport.send(chunk.text));
    yield* Result.isFailure(sent)
      ? journal.markAttemptUnknown(attemptId, safeErrorDiagnostic(sent.failure), new Date())
      : journal.markSent(attemptId, chunk.id, new Date());
    const receipt = yield* findWithPolling(transport, frontierRowId, chunk.text);
    if (receipt !== null) {
      return yield* markReceipt(journal, chunk, attemptId, receipt);
    }
    if (Result.isSuccess(sent)) {
      return yield* Effect.void;
    }
    yield* journal.markAttemptUnknown(attemptId, 'confirmation timeout', new Date());
    return yield* confirmationTimeout();
  });
  const handleDeliveryError = (error: MessagesDeliveryError): Effect.Effect<never, DeliveryError> =>
    attemptStarted ? terminalizeChunk(journal, chunk, error) : Effect.fail(error);
  return delivery.pipe(Effect.catchTag('MessagesDeliveryError', handleDeliveryError));
};

const deliverPrepared = Effect.fn('SpikeDelivery.deliverPrepared')(function* deliverPrepared(
  journal: DeliveryJournal,
  transport: MessagesTransport,
  prepared: PreparedDelivery,
  claimAttempt: DeliveryJournal['claimAttempt'] = journal.claimAttempt,
) {
  for (const chunk of prepared.chunks) {
    if (chunk.state !== 'Sent' && chunk.state !== 'Reconciled' && chunk.state !== 'Failed') {
      yield* deliverChunk(journal, transport, chunk, claimAttempt);
    }
  }
});

const makeDeliveryService = (
  journal: DeliveryJournal,
  transport: MessagesTransport,
): DeliveryService => ({
  deliverControlMessage: (sourceId, text, createdAt): Effect.Effect<void, DeliveryError> =>
    journal
      .prepareControlMessage(sourceId, text, createdAt)
      .pipe(Effect.flatMap((prepared) => deliverPrepared(journal, transport, prepared))),
  deliverFailureNotice: (logicalTurnId, text, createdAt): Effect.Effect<void, DeliveryError> =>
    journal
      .prepareFailureNotice(logicalTurnId, text, createdAt)
      .pipe(Effect.flatMap((prepared) => deliverPrepared(journal, transport, prepared))),
  deliverOutageNotice: (outageEpisodeId, text, createdAt): Effect.Effect<void, DeliveryError> =>
    journal
      .prepareOutageNotice(outageEpisodeId, text, createdAt)
      .pipe(Effect.flatMap((prepared) => deliverPrepared(journal, transport, prepared))),
  deliverPreparedTurnNotice: (prepared): Effect.Effect<void, DeliveryError> =>
    deliverPrepared(journal, transport, prepared, (chunkId, frontierRowId, startedAt) =>
      journal.claimTurnAttempt(prepared.identity, chunkId, frontierRowId, startedAt),
    ),
  prepareTurnNotice: journal.prepareTurnNotice,
  recover: Effect.gen(function* recoverDelivery() {
    const chunks = yield* journal.listRecoverable;
    for (const chunk of chunks) {
      yield* deliverChunk(journal, transport, chunk).pipe(
        Effect.catchTag('MessagesDeliveryError', () => Effect.void),
      );
    }
  }),
});

export { makeDeliveryService };
export type { DeliveryError, DeliveryService };
