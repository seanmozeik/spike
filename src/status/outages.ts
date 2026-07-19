import type { Database } from 'bun:sqlite';

import { CODEX_OUTAGE_KINDS } from '../outage/journal';

const readOpenOutageKinds = (database: Database): readonly string[] =>
  database
    .query<{ kind: string }, [string, string, string]>(
      `SELECT kind FROM outage_episodes
       WHERE state = 'Open' AND kind IN (?, ?, ?)
       ORDER BY opened_at, kind`,
    )
    .all(...CODEX_OUTAGE_KINDS)
    .map(({ kind }) => kind);

export { readOpenOutageKinds };
