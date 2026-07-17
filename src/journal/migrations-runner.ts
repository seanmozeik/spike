import type { Database } from 'bun:sqlite';

import { applyVersionedMigrations, migrationStatements, SCHEMA_VERSION } from './migrations';

const applyMigrations = (database: Database): void => {
  const migrate = database.transaction(() => {
    const [schemaMeta, ...domainStatements] = migrationStatements;
    database.run(schemaMeta);
    const previousVersion =
      database
        .query<{ version: number | null }, []>('SELECT MAX(version) AS version FROM schema_meta')
        .get()?.version ?? 0;
    for (const statement of domainStatements) {
      database.run(statement);
    }
    applyVersionedMigrations(database, previousVersion);
    database.run(
      `INSERT OR IGNORE INTO schema_meta(version, applied_at)
       VALUES (${SCHEMA_VERSION}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    );
  });
  migrate();
};

export { applyMigrations };
