import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import { type LogicalTurnId, OutboundMessageId } from '../domain/ids';
import { JournalTransactionError } from '../errors';
import { chunkFinalAnswer } from './chunk';
import type { AssistantMessageKind, DeliveryJournal, PreparedDelivery } from './model';
import { applyPlainTextFallback } from './plain-text';

type DeliverySourceKind = 'CodexAgentItem' | 'Control';

interface PrepareInput {
  readonly createdAt: string;
  readonly kind: AssistantMessageKind;
  readonly logicalTurnId: LogicalTurnId | null;
  readonly sourceId: string;
  readonly sourceKind: DeliverySourceKind;
  readonly text: string;
}

interface PrepareFunctions {
  readonly assistant: DeliveryJournal['prepareAssistantMessage'];
  readonly control: DeliveryJournal['prepareControlMessage'];
}

const ACKNOWLEDGEMENT_LIMIT = 240;

const deliveryTexts = (kind: AssistantMessageKind, text: string): readonly string[] =>
  kind === 'WorkAck' ? [text.slice(0, ACKNOWLEDGEMENT_LIMIT)] : chunkFinalAnswer(text);

const prepareRows = (database: Database, input: PrepareInput): string => {
  const { createdAt, kind, logicalTurnId, sourceId, sourceKind } = input;
  const text = applyPlainTextFallback(input.text);
  if (text.trim().length === 0) {
    throw new Error('assistant delivery text must not be empty');
  }
  const existing = database
    .query<{ id: string }, [string, string, string]>(
      `SELECT id FROM outbound_messages
       WHERE source_kind = ? AND source_id = ? AND message_kind = ?`,
    )
    .get(sourceKind, sourceId, kind);
  if (existing !== null) {
    return existing.id;
  }
  const outboundMessageId = OutboundMessageId.make(randomUUID());
  database.run(
    `INSERT INTO outbound_messages(
       id, logical_turn_id, source_kind, source_id, message_kind, text, state, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'Prepared', ?)`,
    [outboundMessageId, logicalTurnId, sourceKind, sourceId, kind, text, createdAt],
  );
  for (const [ordinal, chunkText] of deliveryTexts(kind, text).entries()) {
    database.run(
      `INSERT INTO outbound_chunks(id, outbound_message_id, ordinal, text, state)
       VALUES (?, ?, ?, ?, 'Prepared')`,
      [randomUUID(), outboundMessageId, ordinal, chunkText],
    );
  }
  return outboundMessageId;
};

const makePrepare = (
  database: Database,
  readPrepared: (outboundMessageId: string, kind: AssistantMessageKind) => PreparedDelivery,
): PrepareFunctions => {
  const transaction = database.transaction(prepareRows);
  const prepare = (
    logicalTurnId: LogicalTurnId | null,
    sourceKind: DeliverySourceKind,
    sourceId: string,
    kind: AssistantMessageKind,
    text: string,
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
        const id = transaction(database, {
          createdAt: createdAt.toISOString(),
          kind,
          logicalTurnId,
          sourceId,
          sourceKind,
          text,
        });
        return readPrepared(id, kind);
      },
    });
  return {
    assistant: (logicalTurnId, sourceId, kind, text, createdAt) =>
      prepare(logicalTurnId, 'CodexAgentItem', sourceId, kind, text, createdAt),
    control: (sourceId, text, createdAt) =>
      prepare(null, 'Control', sourceId, 'Final', text, createdAt),
  };
};

export { makePrepare };
