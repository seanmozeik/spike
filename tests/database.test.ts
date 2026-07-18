import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { ensureRuntimeLayout } from '../src/config-files';
import { inspectJournal, journalInfo, openJournal } from '../src/database';
import { spikePaths } from '../src/paths';

const roots: string[] = [];

const mode = (file: string): string => statSync(file).mode.toString(8).slice(-3);

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
    expect(
      journal.database
        .query<{ name: string }, []>('PRAGMA table_info(approval_requests)')
        .all()
        .map(({ name }) => name),
    ).toContain('payload_redacted_at');
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      expect(existsSync(file)).toBe(true);
      expect(mode(file)).toBe('600');
    }
    journal.close();
    expect(inspectJournal(databasePath)).toStrictEqual({
      journalMode: 'wal',
      migrationVersion: 11,
    });
  }),
);

it.effect('hardens insecure journal files again after reopen and sidecar recreation', () =>
  Effect.gen(function* reopenPermissionsFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-db-reopen-'));
    roots.push(root);
    const databasePath = path.join(root, 'spike.db');
    const journalFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
    const first = yield* openJournal(databasePath);
    for (const file of journalFiles) {
      chmodSync(file, 0o644);
    }

    const concurrentReopen = yield* openJournal(databasePath);
    expect(journalFiles.map((file) => mode(file))).toStrictEqual(journalFiles.map(() => '600'));
    concurrentReopen.close();
    first.close();

    chmodSync(databasePath, 0o644);
    const recreated = yield* openJournal(databasePath);
    for (const file of journalFiles) {
      expect(existsSync(file)).toBe(true);
      expect(mode(file)).toBe('600');
    }
    recreated.close();
  }),
);

it.effect('converges runtime directories and sensitive files to owner-only modes', () =>
  Effect.gen(function* runtimeLayoutFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-layout-'));
    roots.push(root);
    const paths = spikePaths(root);
    yield* ensureRuntimeLayout(paths);

    const directories = [
      paths.root,
      paths.codexHome,
      paths.accounts,
      paths.state,
      paths.run,
      paths.logs,
    ];
    for (const directory of directories) {
      chmodSync(directory, 0o755);
    }
    writeFileSync(paths.config, 'chat_guid = "test"\n', { mode: 0o644 });
    chmodSync(paths.daemonLog, 0o644);

    yield* ensureRuntimeLayout(paths);

    expect(directories.map((directory) => mode(directory))).toStrictEqual(
      directories.map(() => '700'),
    );
    expect(mode(paths.config)).toBe('600');
    expect(mode(paths.daemonLog)).toBe('600');
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
    expect(inspectJournal(databasePath).migrationVersion).toBe(11);
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
    expect(inspectJournal(databasePath).migrationVersion).toBe(11);
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
    expect(inspectJournal(databasePath).migrationVersion).toBe(11);
  }),
);

it.effect('migrates version 10 approval rows to the payload retention marker', () =>
  Effect.gen(function* approvalRetentionMigrationFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-db-v10-'));
    roots.push(root);
    const databasePath = path.join(root, 'spike.db');
    const initial = yield* openJournal(databasePath);
    initial.close();

    const versionTen = new Database(databasePath, { strict: true });
    versionTen.run('ALTER TABLE approval_requests DROP COLUMN payload_redacted_at');
    versionTen.run('DELETE FROM schema_meta');
    versionTen.run(
      "INSERT INTO schema_meta(version, applied_at) VALUES (10, '2026-07-15T00:00:00.000Z')",
    );
    versionTen.close();

    const migrated = yield* openJournal(databasePath);
    const columns = migrated.database
      .query<{ name: string }, []>('PRAGMA table_info(approval_requests)')
      .all()
      .map(({ name }) => name);
    migrated.close();

    expect(columns).toContain('payload_redacted_at');
    expect(inspectJournal(databasePath).migrationVersion).toBe(11);
  }),
);
