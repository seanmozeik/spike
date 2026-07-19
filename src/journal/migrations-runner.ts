import type { Database } from 'bun:sqlite';

import { migrationStatements, SCHEMA_VERSION } from './migrations';
import {
  applyVersionedMigrations,
  needsDurableScheduleInboundRebuild,
} from './versioned-migrations';

const applyMigrations = (database: Database): void => {
  const [schemaMeta, ...domainStatements] = migrationStatements;
  database.run(schemaMeta);
  const previousVersion =
    database
      .query<{ version: number | null }, []>('SELECT MAX(version) AS version FROM schema_meta')
      .get()?.version ?? 0;
  const rebuildInbound = needsDurableScheduleInboundRebuild(previousVersion);
  if (rebuildInbound) {
    database.run('PRAGMA foreign_keys = OFF');
    database.run('PRAGMA legacy_alter_table = ON');
  }
  const migrate = database.transaction(() => {
    for (const statement of domainStatements) {
      database.run(statement);
    }
    applyVersionedMigrations(database, previousVersion);
    database.run(
      `INSERT OR IGNORE INTO schema_meta(version, applied_at)
       VALUES (${SCHEMA_VERSION}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    );
  });
  try {
    migrate();
  } finally {
    if (rebuildInbound) {
      database.run('PRAGMA legacy_alter_table = OFF');
      database.run('PRAGMA foreign_keys = ON');
    }
  }
  const violations = database.query<unknown, []>('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new Error('journal migration left foreign-key violations');
  }
};

export { applyMigrations };
