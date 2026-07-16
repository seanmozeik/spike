import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import type { ChatGuid, MessagesRowId } from '../domain/ids';
import { JournalTransactionError } from '../errors';

const makeInitializeInboxCursor =
  (database: Database) =>
  (
    chatGuid: ChatGuid,
    frontier: MessagesRowId,
    initializedAt: Date,
  ): Effect.Effect<void, JournalTransactionError> =>
    Effect.try({
      catch: (cause) =>
        new JournalTransactionError({
          cause,
          message: 'failed to initialize the Messages frontier',
          transaction: 'initializeInboxCursor',
        }),
      try: () => {
        database.run(
          `INSERT OR IGNORE INTO inbox_cursor(
            chat_guid, last_rowid, last_message_guid, updated_at
          ) VALUES (?, ?, NULL, ?)`,
          [chatGuid, frontier, initializedAt.toISOString()],
        );
      },
    });

export { makeInitializeInboxCursor };
