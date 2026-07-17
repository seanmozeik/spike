import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { inspectJournal, journalInfo, openJournal } from '../src/database';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('opens the daemon-owned journal with durable pragmas', () =>
  Effect.gen(function* databaseFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-db-'));
    roots.push(root);
    const databasePath = path.join(root, 'spike.db');
    const journal = yield* openJournal(databasePath);
    expect(journalInfo(journal.database)).toStrictEqual({
      foreignKeys: 1,
      journalMode: 'wal',
      synchronous: 2,
    });
    journal.close();
    expect(inspectJournal(databasePath)).toStrictEqual({
      journalMode: 'wal',
      migrationVersion: 10,
    });
  }),
);

it.effect('migrates a version 6 scheduler journal to the canonical generation thread', () =>
  Effect.gen(function* versionSixMigrationFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-db-v6-'));
    roots.push(root);
    const databasePath = path.join(root, 'spike.db');
    const initial = yield* openJournal(databasePath);
    initial.close();

    const versionSix = new Database(databasePath, { strict: true });
    versionSix.run('ALTER TABLE scheduler_state ADD COLUMN codex_thread_id TEXT');
    versionSix.run('ALTER TABLE scheduler_state DROP COLUMN generation_broken');
    versionSix.run('DELETE FROM schema_meta');
    versionSix.run(
      "INSERT INTO schema_meta(version, applied_at) VALUES (6, '2026-07-14T00:00:00.000Z')",
    );
    versionSix.close();

    const migrated = yield* openJournal(databasePath);
    const columns = migrated.database
      .query<{ name: string }, []>('PRAGMA table_info(scheduler_state)')
      .all()
      .map((column) => column.name);
    migrated.close();

    expect(columns).not.toContain('codex_thread_id');
    expect(columns).toContain('generation_broken');
    expect(inspectJournal(databasePath).migrationVersion).toBe(10);
  }),
);

it.effect('migrates a version 7 journal to durable broken-generation state', () =>
  Effect.gen(function* versionSevenMigrationFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-db-v7-'));
    roots.push(root);
    const databasePath = path.join(root, 'spike.db');
    const initial = yield* openJournal(databasePath);
    initial.close();

    const versionSeven = new Database(databasePath, { strict: true });
    versionSeven.run('ALTER TABLE scheduler_state DROP COLUMN generation_broken');
    versionSeven.run('DELETE FROM schema_meta');
    versionSeven.run(
      "INSERT INTO schema_meta(version, applied_at) VALUES (7, '2026-07-15T00:00:00.000Z')",
    );
    versionSeven.close();

    const migrated = yield* openJournal(databasePath);
    const columns = migrated.database
      .query<{ name: string }, []>('PRAGMA table_info(scheduler_state)')
      .all()
      .map((column) => column.name);
    migrated.close();

    expect(columns).toContain('generation_broken');
    expect(inspectJournal(databasePath).migrationVersion).toBe(10);
  }),
);

it.effect('migrates failed logical turns to terminal Codex attempts', () =>
  Effect.gen(function* failedAttemptMigrationFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-db-v8-'));
    roots.push(root);
    const databasePath = path.join(root, 'spike.db');
    const initial = yield* openJournal(databasePath);
    initial.database.run(
      "INSERT INTO generations(id, sequence, state, created_at) VALUES ('generation', 1, 'Current', '2026-07-15T00:00:00.000Z')",
    );
    initial.database.run(
      "INSERT INTO logical_turns(id, generation_id, sequence, state, correlation_id, created_at, completed_at) VALUES ('turn', 'generation', 1, 'Failed', 'correlation', '2026-07-15T00:00:00.000Z', '2026-07-15T00:01:00.000Z')",
    );
    initial.database.run(
      "INSERT INTO codex_attempts(id, logical_turn_id, state, started_at) VALUES ('attempt', 'turn', 'Accepted', '2026-07-15T00:00:10.000Z')",
    );
    initial.database.run('DELETE FROM schema_meta');
    initial.database.run(
      "INSERT INTO schema_meta(version, applied_at) VALUES (8, '2026-07-15T00:02:00.000Z')",
    );
    initial.close();

    const migrated = yield* openJournal(databasePath);
    const attempt = migrated.database
      .query<{ finished_at: string; state: string }, []>(
        "SELECT state, finished_at FROM codex_attempts WHERE id = 'attempt'",
      )
      .get();
    migrated.close();

    expect(attempt).toStrictEqual({ finished_at: '2026-07-15T00:01:00.000Z', state: 'Failed' });
    expect(inspectJournal(databasePath).migrationVersion).toBe(10);
  }),
);
