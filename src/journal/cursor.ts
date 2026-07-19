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

const makeAdvanceInboxCursor =
  (database: Database) =>
  (
    chatGuid: ChatGuid,
    frontier: MessagesRowId,
    advancedAt: Date,
  ): Effect.Effect<void, JournalTransactionError> =>
    Effect.try({
      catch: (cause) =>
        new JournalTransactionError({
          cause,
          message: 'failed to advance the idle Messages frontier',
          transaction: 'advanceInboxCursor',
        }),
      try: () => {
        database.run(
          `INSERT INTO inbox_cursor(
            chat_guid, last_rowid, last_message_guid, updated_at
          ) VALUES (?, ?, NULL, ?)
          ON CONFLICT(chat_guid) DO UPDATE SET
            last_rowid = excluded.last_rowid,
            updated_at = excluded.updated_at
          WHERE excluded.last_rowid > inbox_cursor.last_rowid`,
          [chatGuid, frontier, advancedAt.toISOString()],
        );
      },
    });

export { makeAdvanceInboxCursor, makeInitializeInboxCursor };
