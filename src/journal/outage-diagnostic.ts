import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import { journalTransactionError, type JournalTransactionError } from '../errors';

interface OutageDiagnostic {
  readonly open: (at: Date) => Effect.Effect<boolean, JournalTransactionError>;
  readonly resolve: (at: Date) => Effect.Effect<boolean, JournalTransactionError>;
}

interface OutageDiagnosticSpec {
  readonly errorTag: string;
  readonly kind: string;
  readonly message: string;
  readonly operation: string;
}

interface OpenEpisodeRow {
  readonly id: string;
}

const makeOpen = (database: Database, spec: OutageDiagnosticSpec): ((at: string) => boolean) =>
  database.transaction((at: string): boolean => {
    const existing = database
      .query<OpenEpisodeRow, [string]>(
        "SELECT id FROM outage_episodes WHERE kind = ? AND state = 'Open'",
      )
      .get(spec.kind);
    if (existing !== null) {
      return false;
    }
    const episodeId = randomUUID();
    database.run(
      "INSERT INTO outage_episodes(id, kind, state, opened_at) VALUES (?, ?, 'Open', ?)",
      [episodeId, spec.kind, at],
    );
    database.run(
      `INSERT INTO failures(
         correlation_id, operation, error_tag, message, details_json, created_at
       ) VALUES (?, ?, ?, ?, NULL, ?)`,
      [episodeId, spec.operation, spec.errorTag, spec.message, at],
    );
    return true;
  });

const makeResolve = (database: Database, kind: string): ((at: string) => boolean) =>
  database.transaction((at: string): boolean => {
    const changed = database.run(
      `UPDATE outage_episodes SET state = 'Resolved', resolved_at = ?
       WHERE kind = ? AND state = 'Open'`,
      [at, kind],
    );
    return changed.changes === 1;
  });

const makeOutageDiagnostic = (database: Database, spec: OutageDiagnosticSpec): OutageDiagnostic => {
  const open = makeOpen(database, spec);
  const resolve = makeResolve(database, spec.kind);
  return {
    open: (at) =>
      Effect.try({
        catch: (cause) =>
          journalTransactionError(
            'openOutageDiagnostic',
            `failed to persist the ${spec.kind} outage diagnostic`,
            cause,
          ),
        try: () => open(at.toISOString()),
      }),
    resolve: (at) =>
      Effect.try({
        catch: (cause) =>
          journalTransactionError(
            'resolveOutageDiagnostic',
            `failed to resolve the ${spec.kind} outage diagnostic`,
            cause,
          ),
        try: () => resolve(at.toISOString()),
      }),
  };
};

export { makeOutageDiagnostic };
export type { OutageDiagnostic, OutageDiagnosticSpec };
