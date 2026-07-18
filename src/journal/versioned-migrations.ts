import type { Database } from 'bun:sqlite';

const DELIVERY_FRONTIER_VERSION = 5;
const CANONICAL_GENERATION_THREAD_VERSION = 7;
const BROKEN_GENERATION_STATE_VERSION = 8;
const TERMINAL_ATTEMPT_STATE_VERSION = 9;
const APPROVAL_PAYLOAD_RETENTION_VERSION = 11;

const hasColumn = (database: Database, table: string, column: string): boolean =>
  database
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some(({ name }) => name === column);

const applyVersionedMigrations = (database: Database, previousVersion: number): void => {
  if (previousVersion === 1) {
    database.run('ALTER TABLE generations ADD COLUMN codex_thread_id TEXT');
    database.run('ALTER TABLE generations ADD COLUMN prompt_version TEXT');
    database.run('ALTER TABLE generations ADD COLUMN config_version TEXT');
    database.run('ALTER TABLE codex_attempts ADD COLUMN input_fingerprint TEXT');
    database.run('ALTER TABLE codex_attempts ADD COLUMN frontier_json TEXT');
    database.run(
      "ALTER TABLE codex_attempts ADD COLUMN submission_kind TEXT CHECK(submission_kind IN ('Start','Steer'))",
    );
    database.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS generations_codex_thread ON generations(codex_thread_id)',
    );
  }
  if (previousVersion === 1 || previousVersion === 2) {
    database.run('ALTER TABLE logical_turns ADD COLUMN acknowledged_at TEXT');
  }
  if (previousVersion > 0 && previousVersion < DELIVERY_FRONTIER_VERSION) {
    database.run('ALTER TABLE delivery_attempts ADD COLUMN frontier_rowid INTEGER');
  }
  if (previousVersion > 0 && previousVersion < CANONICAL_GENERATION_THREAD_VERSION) {
    database.run('ALTER TABLE scheduler_state DROP COLUMN codex_thread_id');
  }
  if (previousVersion > 0 && previousVersion < BROKEN_GENERATION_STATE_VERSION) {
    database.run(
      'ALTER TABLE scheduler_state ADD COLUMN generation_broken INTEGER NOT NULL DEFAULT 0 CHECK(generation_broken IN (0,1))',
    );
  }
  if (previousVersion > 0 && previousVersion < TERMINAL_ATTEMPT_STATE_VERSION) {
    database.run(
      `UPDATE codex_attempts SET state = 'Failed', finished_at = COALESCE(
           finished_at,
           (SELECT completed_at FROM logical_turns WHERE logical_turns.id = codex_attempts.logical_turn_id),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ) WHERE state IN ('Prepared','Submitted','SubmissionUnknown','Accepted')
           AND logical_turn_id IN (SELECT id FROM logical_turns WHERE state = 'Failed')`,
    );
  }
  if (
    previousVersion > 0 &&
    previousVersion < APPROVAL_PAYLOAD_RETENTION_VERSION &&
    !hasColumn(database, 'approval_requests', 'payload_redacted_at')
  ) {
    database.run('ALTER TABLE approval_requests ADD COLUMN payload_redacted_at TEXT');
  }
};

export { applyVersionedMigrations };
