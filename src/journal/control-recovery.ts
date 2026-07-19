import type { Database } from 'bun:sqlite';

import type { Effect } from 'effect';

import type { ControlCommand } from '../domain/control-command';
import { InboundMessageId } from '../domain/ids';
import { tryJournalTransaction, type JournalTransactionError } from '../errors';

interface PendingControl {
  readonly command: ControlCommand;
  readonly inboundMessageId: InboundMessageId;
}

interface PendingControlRow {
  readonly command: ControlCommand;
  readonly inbound_message_id: string;
}

const makeListPendingControls =
  (database: Database) => (): Effect.Effect<readonly PendingControl[], JournalTransactionError> =>
    tryJournalTransaction(
      'listPendingControls',
      'failed to load control replies awaiting delivery',
      () =>
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
    );

export { makeListPendingControls };
export type { PendingControl };
