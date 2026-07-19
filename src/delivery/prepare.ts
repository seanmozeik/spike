import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import { type LogicalTurnId, type OutageEpisodeId, OutboundMessageId } from '../domain/ids';
import { JournalTransactionError } from '../errors';
import { chunkFinalAnswer } from './chunk';
import type { DeliveryJournal, DeliveryMessageKind, PreparedDelivery } from './model';
import { applyPlainTextFallback } from './plain-text';

type DeliverySourceKind = 'CodexAgentItem' | 'Control' | 'OutageEpisode' | 'TurnFailureNotice';

interface PrepareInput {
  readonly createdAt: string;
  readonly kind: DeliveryMessageKind;
  readonly logicalTurnId: LogicalTurnId | null;
  readonly outageEpisodeId: OutageEpisodeId | null;
  readonly sourceId: string;
  readonly sourceKind: DeliverySourceKind;
  readonly text: string;
}

type PendingPrepareInput = Omit<PrepareInput, 'createdAt'>;

interface PrepareFunctions {
  readonly assistant: DeliveryJournal['prepareAssistantMessage'];
  readonly control: DeliveryJournal['prepareControlMessage'];
  readonly failure: DeliveryJournal['prepareFailureNotice'];
  readonly outage: DeliveryJournal['prepareOutageNotice'];
}

const ACKNOWLEDGEMENT_LIMIT = 240;

const deliveryTexts = (kind: DeliveryMessageKind, text: string): readonly string[] =>
  kind === 'WorkAck' ? [text.slice(0, ACKNOWLEDGEMENT_LIMIT)] : chunkFinalAnswer(text);

const findExisting = (database: Database, input: PrepareInput): string | null => {
  if (input.sourceKind === 'TurnFailureNotice' && input.logicalTurnId !== null) {
    return (
      database
        .query<{ id: string }, [string]>(
          `SELECT id FROM outbound_messages
           WHERE logical_turn_id = ? AND source_kind = 'TurnFailureNotice'`,
        )
        .get(input.logicalTurnId)?.id ?? null
    );
  }
  return (
    database
      .query<{ id: string }, [string, string, string]>(
        `SELECT id FROM outbound_messages
         WHERE source_kind = ? AND source_id = ? AND message_kind = ?`,
      )
      .get(input.sourceKind, input.sourceId, input.kind)?.id ?? null
  );
};

const insertOutboundMessage = (
  database: Database,
  input: PrepareInput,
  text: string,
): OutboundMessageId => {
  const { createdAt, kind, logicalTurnId, outageEpisodeId, sourceId, sourceKind } = input;
  const outboundMessageId = OutboundMessageId.make(randomUUID());
  database.run(
    `INSERT INTO outbound_messages(
       id, logical_turn_id, outage_episode_id, source_kind, source_id, message_kind, text, state,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Prepared', ?)`,
    [
      outboundMessageId,
      logicalTurnId,
      outageEpisodeId,
      sourceKind,
      sourceId,
      kind,
      text,
      createdAt,
    ],
  );
  return outboundMessageId;
};

const insertChunks = (
  database: Database,
  outboundMessageId: OutboundMessageId,
  kind: DeliveryMessageKind,
  text: string,
): void => {
  for (const [ordinal, chunkText] of deliveryTexts(kind, text).entries()) {
    database.run(
      `INSERT INTO outbound_chunks(id, outbound_message_id, ordinal, text, state)
       VALUES (?, ?, ?, ?, 'Prepared')`,
      [randomUUID(), outboundMessageId, ordinal, chunkText],
    );
  }
};

const prepareRows = (database: Database, input: PrepareInput): string => {
  const text = applyPlainTextFallback(input.text);
  if (text.trim().length === 0) {
    throw new Error('assistant delivery text must not be empty');
  }
  const existing = findExisting(database, input);
  if (existing !== null) {
    return existing;
  }
  const outboundMessageId = insertOutboundMessage(database, input, text);
  insertChunks(database, outboundMessageId, input.kind, text);
  return outboundMessageId;
};

const assistantInput = (
  logicalTurnId: LogicalTurnId,
  sourceId: string,
  kind: DeliveryMessageKind,
  text: string,
): PendingPrepareInput => ({
  kind,
  logicalTurnId,
  outageEpisodeId: null,
  sourceId,
  sourceKind: 'CodexAgentItem',
  text,
});

const controlInput = (sourceId: string, text: string): PendingPrepareInput => ({
  kind: 'Final',
  logicalTurnId: null,
  outageEpisodeId: null,
  sourceId,
  sourceKind: 'Control',
  text,
});

const failureInput = (logicalTurnId: LogicalTurnId, text: string): PendingPrepareInput => ({
  kind: 'Final',
  logicalTurnId,
  outageEpisodeId: null,
  sourceId: logicalTurnId,
  sourceKind: 'TurnFailureNotice',
  text,
});

const outageInput = (outageEpisodeId: OutageEpisodeId, text: string): PendingPrepareInput => ({
  kind: 'OutageNotice',
  logicalTurnId: null,
  outageEpisodeId,
  sourceId: outageEpisodeId,
  sourceKind: 'OutageEpisode',
  text,
});

const makePrepare = (
  database: Database,
  readPrepared: (outboundMessageId: string, kind: DeliveryMessageKind) => PreparedDelivery,
): PrepareFunctions => {
  const transaction = database.transaction(prepareRows);
  const prepare = (
    input: PendingPrepareInput,
    createdAt: Date,
  ): Effect.Effect<PreparedDelivery, JournalTransactionError> =>
    Effect.try({
      catch: (cause) =>
        new JournalTransactionError({
          cause,
          message: 'prepare delivery failed',
          transaction: 'prepareDelivery',
        }),
      try: () => {
        const id = transaction(database, { createdAt: createdAt.toISOString(), ...input });
        return readPrepared(id, input.kind);
      },
    });
  return {
    assistant: (logicalTurnId, sourceId, kind, text, createdAt) =>
      prepare(assistantInput(logicalTurnId, sourceId, kind, text), createdAt),
    control: (sourceId, text, createdAt) => prepare(controlInput(sourceId, text), createdAt),
    failure: (logicalTurnId, text, createdAt) =>
      prepare(failureInput(logicalTurnId, text), createdAt),
    outage: (outageEpisodeId, text, createdAt) =>
      prepare(outageInput(outageEpisodeId, text), createdAt),
  };
};

const prepareOutageRows = (
  database: Database,
  outageEpisodeId: OutageEpisodeId,
  text: string,
  createdAt: Date,
): string =>
  prepareRows(database, {
    ...outageInput(outageEpisodeId, text),
    createdAt: createdAt.toISOString(),
  });

export { makePrepare, prepareOutageRows };
