import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import { journalTransactionError, type JournalTransactionError } from '../errors';

interface ConversationDiagnostic {
  readonly open: (at: Date) => Effect.Effect<boolean, JournalTransactionError>;
  readonly resolve: (at: Date) => Effect.Effect<boolean, JournalTransactionError>;
}

interface OpenEpisodeRow {
  readonly id: string;
}

const EPISODE_KIND = 'MessagesConversationBoundaryInvalid';
const DIAGNOSTIC_MESSAGE =
  'Configured Messages conversation no longer matches its trusted direct iMessage boundary';

const makeOpen = (database: Database): ((at: string) => boolean) =>
  database.transaction((at: string): boolean => {
    const existing = database
      .query<OpenEpisodeRow, [string]>(
        "SELECT id FROM outage_episodes WHERE kind = ? AND state = 'Open'",
      )
      .get(EPISODE_KIND);
    if (existing !== null) {
      return false;
    }
    const episodeId = randomUUID();
    database.run(
      "INSERT INTO outage_episodes(id, kind, state, opened_at) VALUES (?, ?, 'Open', ?)",
      [episodeId, EPISODE_KIND, at],
    );
    database.run(
      `INSERT INTO failures(
         correlation_id, operation, error_tag, message, details_json, created_at
       ) VALUES (?, 'messages-conversation-validation', 'ConversationBoundaryInvalid', ?, NULL, ?)`,
      [episodeId, DIAGNOSTIC_MESSAGE, at],
    );
    return true;
  });

const makeResolve = (database: Database): ((at: string) => boolean) =>
  database.transaction((at: string): boolean => {
    const changed = database.run(
      `UPDATE outage_episodes SET state = 'Resolved', resolved_at = ?
       WHERE kind = ? AND state = 'Open'`,
      [at, EPISODE_KIND],
    );
    return changed.changes === 1;
  });

const makeConversationDiagnostic = (database: Database): ConversationDiagnostic => {
  const open = makeOpen(database);
  const resolve = makeResolve(database);
  return {
    open: (at) =>
      Effect.try({
        catch: (cause) =>
          journalTransactionError(
            'openConversationDiagnostic',
            'failed to persist the Messages conversation diagnostic',
            cause,
          ),
        try: () => open(at.toISOString()),
      }),
    resolve: (at) =>
      Effect.try({
        catch: (cause) =>
          journalTransactionError(
            'resolveConversationDiagnostic',
            'failed to resolve the Messages conversation diagnostic',
            cause,
          ),
        try: () => resolve(at.toISOString()),
      }),
  };
};

export { DIAGNOSTIC_MESSAGE, EPISODE_KIND, makeConversationDiagnostic };
export type { ConversationDiagnostic };
