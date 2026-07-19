import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import { prepareOutageRows } from '../delivery/prepare';
import { OutageEpisodeId } from '../domain/ids';
import { journalTransactionError, type JournalTransactionError } from '../errors';

type CodexOutageKind = 'CodexAuthentication' | 'CodexCapacity' | 'CodexRuntime';

interface OpenOutage {
  readonly id: OutageEpisodeId;
  readonly kind: string;
  readonly openedAt: Date;
}

interface OpenOutageResult {
  readonly id: OutageEpisodeId;
  readonly opened: boolean;
}

interface OutageJournal {
  readonly listOpen: Effect.Effect<readonly OpenOutage[], JournalTransactionError>;
  readonly open: (
    kind: CodexOutageKind,
    text: string,
    at: Date,
  ) => Effect.Effect<OpenOutageResult, JournalTransactionError>;
  readonly resolve: (at: Date) => Effect.Effect<number, JournalTransactionError>;
}

interface OpenOutageRow {
  readonly id: string;
  readonly kind: string;
  readonly opened_at: string;
}

const CODEX_OUTAGE_KINDS = [
  'CodexAuthentication',
  'CodexCapacity',
  'CodexRuntime',
] as const satisfies readonly CodexOutageKind[];

const journalError = (transaction: string, cause: unknown): JournalTransactionError =>
  journalTransactionError(transaction, `outage journal transaction failed: ${transaction}`, cause);

const makeOpen = (database: Database): OutageJournal['open'] => {
  const transaction = database.transaction(
    (kind: CodexOutageKind, text: string, at: Date): OpenOutageResult => {
      const existing = database
        .query<{ id: string }, [string]>(
          "SELECT id FROM outage_episodes WHERE kind = ? AND state = 'Open'",
        )
        .get(kind);
      const id = OutageEpisodeId.make(existing?.id ?? randomUUID());
      if (existing === null) {
        const timestamp = at.toISOString();
        database.run(
          "INSERT INTO outage_episodes(id, kind, state, opened_at) VALUES (?, ?, 'Open', ?)",
          [id, kind, timestamp],
        );
        database.run(
          `INSERT INTO failures(
             correlation_id, operation, error_tag, message, details_json, created_at
           ) VALUES (?, 'codex-availability', ?, ?, NULL, ?)`,
          [id, kind, text, timestamp],
        );
      }
      prepareOutageRows(database, id, text, at);
      return { id, opened: existing === null };
    },
  );
  return (kind, text, at) =>
    Effect.try({
      catch: (cause) => journalError('openOutage', cause),
      try: () => transaction(kind, text, at),
    });
};

const makeResolve = (database: Database): OutageJournal['resolve'] => {
  const transaction = database.transaction((at: string): number => {
    const open = database
      .query<{ id: string }, [string, string, string]>(
        `SELECT id FROM outage_episodes
         WHERE state = 'Open' AND kind IN (?, ?, ?)`,
      )
      .all(...CODEX_OUTAGE_KINDS);
    for (const { id } of open) {
      database.run("UPDATE outage_episodes SET state = 'Resolved', resolved_at = ? WHERE id = ?", [
        at,
        id,
      ]);
    }
    return open.length;
  });
  return (at) =>
    Effect.try({
      catch: (cause) => journalError('resolveOutages', cause),
      try: () => transaction(at.toISOString()),
    });
};

const makeOutageJournal = (database: Database): OutageJournal => ({
  listOpen: Effect.try({
    catch: (cause) => journalError('listOpenOutages', cause),
    try: () =>
      database
        .query<OpenOutageRow, []>(
          "SELECT id, kind, opened_at FROM outage_episodes WHERE state = 'Open' ORDER BY opened_at, id",
        )
        .all()
        .map((row) => ({
          id: OutageEpisodeId.make(row.id),
          kind: row.kind,
          openedAt: new Date(row.opened_at),
        })),
  }),
  open: makeOpen(database),
  resolve: makeResolve(database),
});

export { makeOutageJournal };
export type { CodexOutageKind, OpenOutage, OpenOutageResult, OutageJournal };
