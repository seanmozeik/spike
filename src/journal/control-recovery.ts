import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import { InboundMessageId } from '../domain/ids';
import { JournalTransactionError } from '../errors';

interface PendingControl {
  readonly command: '/new' | '/status';
  readonly inboundMessageId: InboundMessageId;
}

interface PendingControlRow {
  readonly command: '/new' | '/status';
  readonly inbound_message_id: string;
}

const makeListPendingControls =
  (database: Database) => (): Effect.Effect<readonly PendingControl[], JournalTransactionError> =>
    Effect.try({
      catch: (cause) =>
        new JournalTransactionError({
          cause,
          message: 'failed to load control replies awaiting delivery',
          transaction: 'listPendingControls',
        }),
      try: () =>
        database
          .query<PendingControlRow, []>(
            `SELECT hcm.inbound_message_id, hcm.command
             FROM handled_control_messages hcm
             WHERE NOT EXISTS (
               SELECT 1 FROM outbound_messages om
               WHERE om.source_kind = 'Control'
                 AND om.source_id = hcm.inbound_message_id
                 AND om.message_kind = 'Final'
             )
             ORDER BY hcm.handled_at`,
          )
          .all()
          .map((row) => ({
            command: row.command,
            inboundMessageId: InboundMessageId.make(row.inbound_message_id),
          })),
    });

export { makeListPendingControls };
export type { PendingControl };
