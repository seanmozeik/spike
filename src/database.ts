import { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import { SpikeRuntimeError } from './errors';
import { applyMigrations } from './journal/migrations';

interface JournalHandle {
  readonly database: Database;
  readonly close: () => void;
}

const openJournal = Effect.fn('SpikeJournal.open')(function* openJournal(path: string) {
  return yield* Effect.try({
    catch: (cause) =>
      new SpikeRuntimeError({
        cause,
        message: `failed to open journal ${path}`,
        operation: 'open-journal',
      }),
    try: () => {
      const database = new Database(path, { create: true, strict: true });
      database.run('PRAGMA journal_mode = WAL;');
      database.run('PRAGMA foreign_keys = ON;');
      database.run('PRAGMA synchronous = FULL;');
      applyMigrations(database);
      return {
        close: (): void => {
          database.close();
        },
        database,
      } satisfies JournalHandle;
    },
  });
});

interface JournalInfo {
  readonly journalMode: string;
  readonly foreignKeys: number;
  readonly synchronous: number;
}

const journalInfo = (database: Database): JournalInfo => {
  const mode = database.query<{ journal_mode: string }, []>('PRAGMA journal_mode;').get();
  const foreignKeys = database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys;').get();
  const synchronous = database.query<{ synchronous: number }, []>('PRAGMA synchronous;').get();
  return {
    foreignKeys: foreignKeys?.foreign_keys ?? 0,
    journalMode: mode?.journal_mode ?? 'unknown',
    synchronous: synchronous?.synchronous ?? 0,
  };
};

interface OfflineJournalInfo {
  readonly journalMode: string;
  readonly migrationVersion: number;
}

const inspectJournal = (path: string): OfflineJournalInfo => {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const mode = database.query<{ journal_mode: string }, []>('PRAGMA journal_mode;').get();
    const migration = database
      .query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_meta')
      .get();
    return {
      journalMode: mode?.journal_mode ?? 'unknown',
      migrationVersion: migration?.version ?? 0,
    };
  } finally {
    database.close();
  }
};

export { inspectJournal, journalInfo, openJournal };
export type { JournalHandle, JournalInfo, OfflineJournalInfo };
