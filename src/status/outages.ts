import type { Database } from 'bun:sqlite';

const readOpenOutageKinds = (database: Database): readonly string[] =>
  database
    .query<{ kind: string }, []>(
      "SELECT kind FROM outage_episodes WHERE state = 'Open' ORDER BY opened_at, kind",
    )
    .all()
    .map(({ kind }) => kind);

export { readOpenOutageKinds };
