import { SCHEDULES_DUE_INDEX } from './query-indexes';

const scheduleMigrationStatements = [
  `CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    name TEXT,
    prompt TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('OneShot','Recurring')),
    one_shot_at TEXT,
    rrule TEXT,
    timezone TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('Active','Paused','Completed','Cancelled')),
    next_due_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    last_run_at TEXT,
    payload_redacted_at TEXT,
    CHECK(
      (kind = 'OneShot' AND one_shot_at IS NOT NULL AND rrule IS NULL)
      OR (kind = 'Recurring' AND one_shot_at IS NOT NULL AND rrule IS NOT NULL)
    )
  ) STRICT`,
  SCHEDULES_DUE_INDEX,
  `CREATE TABLE IF NOT EXISTS scheduled_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE RESTRICT,
    scheduled_for TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('Enqueued','Running','Completed','Failed')),
    inbound_message_id TEXT NOT NULL UNIQUE
      REFERENCES inbound_messages(id) ON DELETE RESTRICT,
    logical_turn_id TEXT REFERENCES logical_turns(id) ON DELETE RESTRICT,
    enqueued_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    payload_redacted_at TEXT,
    UNIQUE(schedule_id, scheduled_for)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS scheduled_runs_state ON scheduled_runs(state, scheduled_for)`,
  `CREATE TABLE IF NOT EXISTS schedule_tool_calls (
    call_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    response_json TEXT,
    success INTEGER NOT NULL CHECK(success IN (0,1)),
    created_at TEXT NOT NULL,
    payload_redacted_at TEXT
  ) STRICT`,
] as const;

export { scheduleMigrationStatements };
