import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import {
  InboundMessageId,
  InputBatchId,
  LogicalTurnId,
  type InputBatchId as InputBatchIdType,
  type LogicalTurnId as LogicalTurnIdType,
} from '../domain/ids';
import { JournalTransactionError } from '../errors';
import type { PooledMessage } from '../scheduler/model';
import { attachmentInputTextSql, renderPersistedInputText } from './input-message-text';

interface PersistedInputBatch {
  readonly fingerprint: string;
  readonly id: InputBatchIdType;
  readonly kind: 'Initial' | 'Steer';
  readonly logicalTurnId: LogicalTurnIdType;
  readonly messages: readonly PooledMessage[];
  readonly sequence: number;
}

interface InputBatchMessageRow {
  readonly attachment_text: string | null;
  readonly batch_id: string;
  readonly fingerprint: string;
  readonly id: string;
  readonly kind: 'Initial' | 'Steer';
  readonly logical_turn_id: string;
  readonly observed_at: string;
  readonly sequence: number;
  readonly text: string | null;
}

interface MutableInputBatch {
  readonly fingerprint: string;
  readonly id: InputBatchIdType;
  readonly kind: 'Initial' | 'Steer';
  readonly logicalTurnId: LogicalTurnIdType;
  readonly messages: PooledMessage[];
  readonly sequence: number;
}

const readInputBatches = (
  database: Database,
  logicalTurnId: LogicalTurnIdType,
  kind: 'Initial' | 'Steer',
): readonly PersistedInputBatch[] => {
  const rows = database
    .query<InputBatchMessageRow, [string, string]>(
      `SELECT ib.id AS batch_id, ib.logical_turn_id, ib.sequence, ib.kind, ib.fingerprint,
              im.id, im.observed_at, im.text,
              ${attachmentInputTextSql} AS attachment_text
       FROM input_batches ib
       JOIN input_batch_messages ibm ON ibm.input_batch_id = ib.id
       JOIN inbound_messages im ON im.id = ibm.inbound_message_id
       LEFT JOIN attachments a ON a.inbound_message_id = im.id
       WHERE ib.logical_turn_id = ? AND ib.kind = ?
       GROUP BY ib.id, ib.logical_turn_id, ib.sequence, ib.kind, ib.fingerprint,
                im.id, im.observed_at, im.text, ibm.ordinal
       ORDER BY ib.sequence, ibm.ordinal`,
    )
    .all(logicalTurnId, kind);
  const batches = new Map<string, MutableInputBatch>();
  for (const row of rows) {
    let batch = batches.get(row.batch_id);
    if (batch === undefined) {
      batch = {
        fingerprint: row.fingerprint,
        id: InputBatchId.make(row.batch_id),
        kind: row.kind,
        logicalTurnId: LogicalTurnId.make(row.logical_turn_id),
        messages: [],
        sequence: row.sequence,
      };
      batches.set(row.batch_id, batch);
    }
    batch.messages.push({
      id: InboundMessageId.make(row.id),
      receivedAt: new Date(row.observed_at),
      text: renderPersistedInputText({ attachmentText: row.attachment_text, text: row.text }),
    });
  }
  return [...batches.values()];
};

const makeLoadInputBatches =
  (database: Database) =>
  (
    logicalTurnId: LogicalTurnIdType,
    kind: 'Initial' | 'Steer',
  ): Effect.Effect<readonly PersistedInputBatch[], JournalTransactionError> =>
    Effect.try({
      catch: (cause) =>
        new JournalTransactionError({
          cause,
          message: 'scheduler journal transaction failed: loadInputBatches',
          transaction: 'loadInputBatches',
        }),
      try: () => readInputBatches(database, logicalTurnId, kind),
    });

export { makeLoadInputBatches };
export type { PersistedInputBatch };
