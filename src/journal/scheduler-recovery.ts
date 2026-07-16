import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import { InboundMessageId, type LogicalTurnId } from '../domain/ids';
import { JournalTransactionError } from '../errors';
import type { PooledMessage } from '../scheduler/model';

interface TurnMessageRow {
  readonly id: string;
  readonly observed_at: string;
  readonly text: string | null;
}

const makeLoadLatestBatchMessages =
  (database: Database) =>
  (
    logicalTurnId: LogicalTurnId,
    kind: 'Initial' | 'Steer',
  ): Effect.Effect<readonly PooledMessage[], JournalTransactionError> =>
    Effect.try({
      catch: (cause) =>
        new JournalTransactionError({
          cause,
          message: 'scheduler journal transaction failed: loadLatestBatchMessages',
          transaction: 'loadLatestBatchMessages',
        }),
      try: () =>
        database
          .query<TurnMessageRow, [string, string]>(
            `SELECT im.id, im.observed_at,
                    COALESCE(im.text, '[Attachment: ' || GROUP_CONCAT(a.filename, ', ') || ']') AS text
             FROM input_batches ib
             JOIN input_batch_messages ibm ON ibm.input_batch_id = ib.id
             JOIN inbound_messages im ON im.id = ibm.inbound_message_id
             LEFT JOIN attachments a ON a.inbound_message_id = im.id
             WHERE ib.id = (
               SELECT id FROM input_batches
               WHERE logical_turn_id = ? AND kind = ?
               ORDER BY created_at DESC LIMIT 1
             )
             GROUP BY im.id, im.observed_at, im.text, ib.created_at, ibm.ordinal
             ORDER BY ib.created_at, ibm.ordinal`,
          )
          .all(logicalTurnId, kind)
          .map((row) => ({
            id: InboundMessageId.make(row.id),
            receivedAt: new Date(row.observed_at),
            text: row.text ?? '[Attachment]',
          })),
    });

export { makeLoadLatestBatchMessages };
