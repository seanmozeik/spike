import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { canonicalInputFingerprint } from '../src/codex/reconcile';
import { ensureRuntimeLayout } from '../src/config-files';
import { inspectJournal, journalInfo, openJournal } from '../src/database';
import { SCHEMA_VERSION } from '../src/journal/migrations';
import { spikePaths } from '../src/paths';

const roots: string[] = [];

const mode = (file: string): string => statSync(file).mode.toString(8).slice(-3);

const seedVersionElevenBatchIdentity = (databasePath: string): void => {
  const database = new Database(databasePath, { strict: true });
  const firstCreatedAt = '2026-07-15T00:00:00.000Z';
  const attemptStartedAt = '2026-07-15T00:01:00.000Z';
  const secondCreatedAt = '2026-07-15T00:02:00.000Z';
  database.run('DROP INDEX codex_attempts_one_per_input_batch');
  database.run('DROP INDEX input_batches_turn_sequence');
  database.run('ALTER TABLE codex_attempts DROP COLUMN input_batch_id');
  database.run('ALTER TABLE input_batches DROP COLUMN sequence');
  database.run(
    "INSERT INTO generations(id, sequence, state, created_at) VALUES ('generation', 1, 'Current', ?)",
    [firstCreatedAt],
  );
  database.run(
    `INSERT INTO logical_turns(id, generation_id, sequence, state, correlation_id, created_at)
     VALUES ('turn', 'generation', 1, 'Running', 'correlation', ?)`,
    [firstCreatedAt],
  );
  for (const [id, rowId, createdAt] of [
    ['one', 1, firstCreatedAt],
    ['two', 2, secondCreatedAt],
  ] as const) {
    database.run(
      `INSERT INTO inbound_messages(
         id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
       ) VALUES (?, ?, ?, 'chat', 'handle', 'iMessage', 'same steer', ?, ?)`,
      [`inbound-${id}`, `message-${id}`, rowId, createdAt, createdAt],
    );
    database.run(
      `INSERT INTO input_batches(id, logical_turn_id, kind, fingerprint, created_at)
       VALUES (?, 'turn', 'Steer', ?, ?)`,
      [`batch-${id}`, `inbound-${id}`, createdAt],
    );
    database.run(
      `INSERT INTO input_batch_messages(input_batch_id, inbound_message_id, ordinal)
       VALUES (?, ?, 0)`,
      [`batch-${id}`, `inbound-${id}`],
    );
  }
  database.run(
    `INSERT INTO codex_attempts(
       id, logical_turn_id, state, input_fingerprint, frontier_json, submission_kind, started_at
     ) VALUES ('attempt-one', 'turn', 'Prepared', ?, '{"itemIds":[],"turnIds":[]}', 'Steer', ?)`,
    [canonicalInputFingerprint('same steer'), attemptStartedAt],
  );
  database.run('DELETE FROM schema_meta');
  database.run(
    "INSERT INTO schema_meta(version, applied_at) VALUES (11, '2026-07-15T00:03:00.000Z')",
  );
  database.close();
};

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
    expect(
      journal.database
        .query<{ name: string }, []>('PRAGMA table_info(account_observations)')
        .all()
        .map(({ name }) => name),
    ).toEqual(expect.arrayContaining(['mode', 'selected_at']));
    expect(
      journal.database
        .query<{ name: string }, []>("PRAGMA index_list('attachments')")
        .all()
        .map(({ name }) => name),
    ).toEqual(expect.arrayContaining(['attachments_staged_path', 'attachments_inbound_message']));
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      expect(existsSync(file)).toBe(true);
      expect(mode(file)).toBe('600');
    }
    journal.close();
    expect(inspectJournal(databasePath)).toStrictEqual({
      journalMode: 'wal',
      migrationVersion: SCHEMA_VERSION,
    });
  }),
);

it.effect('migrates schema version 13 account availability into explicit durable modes', () =>
  Effect.gen(function* accountModeMigrationFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-db-account-mode-'));
    roots.push(root);
    const databasePath = path.join(root, 'spike.db');
    const initial = yield* openJournal(databasePath);
    initial.close();
    const legacy = new Database(databasePath, { strict: true });
    legacy.run('ALTER TABLE account_observations DROP COLUMN selected_at');
    legacy.run('ALTER TABLE account_observations DROP COLUMN mode');
    legacy.run(
      `INSERT INTO account_observations(account_id, observed_at, usable, usage_json, reset_at)
       VALUES ('legacy', '2026-07-14T12:00:00.000Z', 0, NULL, NULL)`,
    );
    legacy.run('DELETE FROM schema_meta');
    legacy.run(
      "INSERT INTO schema_meta(version, applied_at) VALUES (13, '2026-07-14T12:00:00.000Z')",
    );
    legacy.close();

    const migrated = yield* openJournal(databasePath);
    expect(
      migrated.database
        .query<{ mode: string; selected_at: string | null }, []>(
          "SELECT mode, selected_at FROM account_observations WHERE account_id = 'legacy'",
        )
        .get(),
    ).toEqual({ mode: 'Capacity', selected_at: null });
    migrated.close();
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
    expect(inspectJournal(databasePath).migrationVersion).toBe(SCHEMA_VERSION);
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
    expect(inspectJournal(databasePath).migrationVersion).toBe(SCHEMA_VERSION);
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
    expect(inspectJournal(databasePath).migrationVersion).toBe(SCHEMA_VERSION);
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
    expect(inspectJournal(databasePath).migrationVersion).toBe(SCHEMA_VERSION);
  }),
);

it.effect('migrates v11 attempts to causal batch identities and remains idempotent', () =>
  Effect.gen(function* batchIdentityMigrationFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-db-v11-'));
    roots.push(root);
    const databasePath = path.join(root, 'spike.db');
    const initial = yield* openJournal(databasePath);
    initial.close();
    seedVersionElevenBatchIdentity(databasePath);

    const migrated = yield* openJournal(databasePath);
    expect(
      migrated.database
        .query<{ id: string; sequence: number }, []>(
          'SELECT id, sequence FROM input_batches ORDER BY sequence',
        )
        .all(),
    ).toStrictEqual([
      { id: 'batch-one', sequence: 1 },
      { id: 'batch-two', sequence: 2 },
    ]);
    expect(
      migrated.database
        .query<{ input_batch_id: string | null }, []>(
          "SELECT input_batch_id FROM codex_attempts WHERE id = 'attempt-one'",
        )
        .get(),
    ).toStrictEqual({ input_batch_id: 'batch-one' });
    expect(inspectJournal(databasePath).migrationVersion).toBe(SCHEMA_VERSION);
    migrated.close();

    const reopened = yield* openJournal(databasePath);
    expect(
      reopened.database
        .query<{ count: number }, [number]>(
          'SELECT COUNT(*) AS count FROM schema_meta WHERE version = ?',
        )
        .get(SCHEMA_VERSION)?.count,
    ).toBe(1);
    expect(
      reopened.database
        .query<{ input_batch_id: string | null }, []>(
          "SELECT input_batch_id FROM codex_attempts WHERE id = 'attempt-one'",
        )
        .get(),
    ).toStrictEqual({ input_batch_id: 'batch-one' });
    reopened.close();
  }),
);

it.effect('migrates the v12 final index to admit a distinct failure-notice role', () =>
  Effect.gen(function* failureNoticeIndexMigration() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-db-v12-'));
    roots.push(root);
    const databasePath = path.join(root, 'spike.db');
    const initial = yield* openJournal(databasePath);
    initial.close();

    const versionTwelve = new Database(databasePath, { strict: true });
    versionTwelve.run('DROP INDEX outbound_one_failure_notice');
    versionTwelve.run('DROP INDEX outbound_one_final');
    versionTwelve.run(
      `CREATE UNIQUE INDEX outbound_one_final
       ON outbound_messages(logical_turn_id, message_kind) WHERE message_kind = 'Final'`,
    );
    versionTwelve.run('DELETE FROM schema_meta');
    versionTwelve.run(
      "INSERT INTO schema_meta(version, applied_at) VALUES (12, '2026-07-15T00:03:00.000Z')",
    );
    versionTwelve.close();

    const migrated = yield* openJournal(databasePath);
    migrated.database.run(
      "INSERT INTO generations(id, sequence, state, created_at) VALUES ('generation', 1, 'Current', '2026-07-15T00:00:00.000Z')",
    );
    migrated.database.run(
      "INSERT INTO logical_turns(id, generation_id, sequence, state, correlation_id, created_at) VALUES ('turn', 'generation', 1, 'Running', 'correlation', '2026-07-15T00:00:00.000Z')",
    );
    for (const [id, sourceKind] of [
      ['failure', 'TurnFailureNotice'],
      ['answer', 'CodexAgentItem'],
    ] as const) {
      migrated.database.run(
        `INSERT INTO outbound_messages(
           id, logical_turn_id, source_kind, source_id, message_kind, text, state, created_at
         ) VALUES (?, 'turn', ?, 'turn-1', 'Final', ?, 'Delivered', '2026-07-15T00:01:00.000Z')`,
        [id, sourceKind, id],
      );
    }
    expect(
      migrated.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM outbound_messages WHERE logical_turn_id = 'turn'",
        )
        .get()?.count,
    ).toBe(2);
    expect(inspectJournal(databasePath).migrationVersion).toBe(SCHEMA_VERSION);
    migrated.close();
  }),
);
