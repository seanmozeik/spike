import { ATTACHMENTS_INBOUND_MESSAGE_INDEX } from './recovery-query';
import { scheduleMigrationStatements } from './schedule-migration-statements';

const SCHEMA_VERSION = 17;

const migrationStatements = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS inbox_cursor (
    chat_guid TEXT PRIMARY KEY,
    last_rowid INTEGER NOT NULL CHECK(last_rowid >= 0),
    last_message_guid TEXT,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('Current','Superseded')),
    created_at TEXT NOT NULL,
    superseded_at TEXT,
    codex_thread_id TEXT UNIQUE,
    prompt_version TEXT,
    config_version TEXT
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS generations_one_current
    ON generations(state) WHERE state = 'Current'`,
  `CREATE TABLE IF NOT EXISTS inbound_messages (
    id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL DEFAULT 'Messages'
      CHECK(source_kind IN ('Messages','ScheduleRun')),
    source_id TEXT,
    message_guid TEXT,
    messages_rowid INTEGER,
    chat_guid TEXT NOT NULL,
    handle TEXT NOT NULL,
    service TEXT NOT NULL CHECK(service IN ('iMessage','Schedule')),
    text TEXT,
    sent_at TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload_redacted_at TEXT,
    CHECK(
      (source_kind = 'Messages' AND message_guid IS NOT NULL
        AND messages_rowid IS NOT NULL AND service = 'iMessage')
      OR (source_kind = 'ScheduleRun' AND source_id IS NOT NULL
        AND message_guid IS NULL AND messages_rowid IS NULL AND service = 'Schedule')
    )
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    inbound_message_id TEXT NOT NULL REFERENCES inbound_messages(id) ON DELETE RESTRICT,
    attachment_guid TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('Observed','Staged','Assigned','Failed','Redacted')),
    filename TEXT,
    transfer_name TEXT,
    mime_type TEXT,
    uti TEXT,
    total_bytes INTEGER,
    source_path TEXT,
    staged_path TEXT,
    content_hash TEXT,
    failure_code TEXT,
    ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal >= 0),
    created_at TEXT NOT NULL,
    payload_redacted_at TEXT
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS attachments_staged_path ON attachments(staged_path)`,
  ATTACHMENTS_INBOUND_MESSAGE_INDEX,
  `CREATE TABLE IF NOT EXISTS logical_turns (
    id TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('Collecting','Submitted','Running','Completed','Failed','Superseded')),
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    acknowledged_at TEXT,
    UNIQUE(generation_id, sequence)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS input_batches (
    id TEXT PRIMARY KEY,
    logical_turn_id TEXT NOT NULL REFERENCES logical_turns(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    kind TEXT NOT NULL CHECK(kind IN ('Initial','Steer')),
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(logical_turn_id, fingerprint)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS input_batch_messages (
    input_batch_id TEXT NOT NULL REFERENCES input_batches(id) ON DELETE RESTRICT,
    inbound_message_id TEXT NOT NULL UNIQUE REFERENCES inbound_messages(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    PRIMARY KEY(input_batch_id, ordinal)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS codex_attempts (
    id TEXT PRIMARY KEY,
    logical_turn_id TEXT NOT NULL REFERENCES logical_turns(id) ON DELETE RESTRICT,
    input_batch_id TEXT REFERENCES input_batches(id) ON DELETE RESTRICT,
    account_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('Prepared','Submitted','SubmissionUnknown','Accepted','Completed','Failed')),
    codex_thread_id TEXT,
    codex_turn_id TEXT UNIQUE,
    input_fingerprint TEXT,
    frontier_json TEXT,
    submission_kind TEXT CHECK(submission_kind IN ('Start','Steer')),
    started_at TEXT NOT NULL,
    finished_at TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS codex_agent_items (
    id TEXT PRIMARY KEY,
    codex_attempt_id TEXT NOT NULL REFERENCES codex_attempts(id) ON DELETE RESTRICT,
    codex_item_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    payload_json TEXT,
    observed_at TEXT NOT NULL,
    payload_redacted_at TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS outbound_messages (
    id TEXT PRIMARY KEY,
    logical_turn_id TEXT REFERENCES logical_turns(id) ON DELETE RESTRICT,
    outage_episode_id TEXT REFERENCES outage_episodes(id) ON DELETE RESTRICT,
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    message_kind TEXT NOT NULL CHECK(message_kind IN ('WorkAck','Final','OutageNotice')),
    text TEXT,
    state TEXT NOT NULL CHECK(state IN ('Prepared','Delivering','Delivered','Failed','Superseded')),
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    payload_redacted_at TEXT,
    UNIQUE(source_kind, source_id, message_kind)
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS outbound_one_work_ack
    ON outbound_messages(logical_turn_id, message_kind) WHERE message_kind = 'WorkAck'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS outbound_one_final
    ON outbound_messages(logical_turn_id, message_kind)
    WHERE message_kind = 'Final' AND source_kind = 'CodexAgentItem'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS outbound_one_failure_notice
    ON outbound_messages(logical_turn_id, source_kind)
    WHERE source_kind = 'TurnFailureNotice'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS outbound_one_outage_notice
    ON outbound_messages(outage_episode_id, message_kind) WHERE message_kind = 'OutageNotice'`,
  `CREATE TABLE IF NOT EXISTS outbound_chunks (
    id TEXT PRIMARY KEY,
    outbound_message_id TEXT NOT NULL REFERENCES outbound_messages(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    text TEXT,
    messages_rowid INTEGER UNIQUE,
    message_guid TEXT UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('Prepared','Sent','Reconciled','Failed')),
    payload_redacted_at TEXT,
    UNIQUE(outbound_message_id, ordinal)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS delivery_attempts (
    id TEXT PRIMARY KEY,
    outbound_chunk_id TEXT NOT NULL REFERENCES outbound_chunks(id) ON DELETE RESTRICT,
    attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
    state TEXT NOT NULL CHECK(state IN ('Started','Sent','Reconciled','Failed','Unknown')),
    started_at TEXT NOT NULL,
    frontier_rowid INTEGER CHECK(frontier_rowid >= 0),
    finished_at TEXT,
    error TEXT,
    UNIQUE(outbound_chunk_id, attempt_number)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS like_attempts (
    id TEXT PRIMARY KEY,
    inbound_message_id TEXT NOT NULL REFERENCES inbound_messages(id) ON DELETE RESTRICT,
    attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
    state TEXT NOT NULL CHECK(state IN ('Started','Succeeded','Failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT,
    UNIQUE(inbound_message_id, attempt_number)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS like_status (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    available INTEGER NOT NULL CHECK(available IN (0,1)),
    degraded INTEGER NOT NULL CHECK(degraded IN (0,1)),
    last_success_at TEXT,
    last_failure_at TEXT,
    last_failure_reason TEXT,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS account_observations (
    id INTEGER PRIMARY KEY,
    account_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    usable INTEGER NOT NULL CHECK(usable IN (0,1)),
    mode TEXT NOT NULL CHECK(mode IN ('Available','Capacity','Authentication')),
    usage_json TEXT,
    reset_at TEXT,
    selected_at TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS outage_episodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('Open','Resolved')),
    opened_at TEXT NOT NULL,
    resolved_at TEXT
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS outage_one_open_per_kind
    ON outage_episodes(kind) WHERE state = 'Open'`,
  `CREATE TABLE IF NOT EXISTS failures (
    id INTEGER PRIMARY KEY,
    correlation_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    error_tag TEXT NOT NULL,
    message TEXT NOT NULL,
    details_json TEXT,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS scheduler_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE RESTRICT,
    active_logical_turn_id TEXT REFERENCES logical_turns(id) ON DELETE RESTRICT,
    active_codex_turn_id TEXT,
    active_acknowledged INTEGER NOT NULL CHECK(active_acknowledged IN (0,1)),
    generation_broken INTEGER NOT NULL DEFAULT 0 CHECK(generation_broken IN (0,1)),
    timer_deadline_at TEXT,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS scheduler_pool_messages (
    inbound_message_id TEXT PRIMARY KEY REFERENCES inbound_messages(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL UNIQUE CHECK(ordinal >= 0)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS handled_control_messages (
    inbound_message_id TEXT PRIMARY KEY REFERENCES inbound_messages(id) ON DELETE RESTRICT,
    command TEXT NOT NULL CHECK(command IN ('/new','/status')),
    handled_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    rpc_request_id_json TEXT NOT NULL,
    method TEXT NOT NULL CHECK(method IN (
      'applyPatchApproval','execCommandApproval','item/commandExecution/requestApproval',
      'item/fileChange/requestApproval','item/permissions/requestApproval'
    )),
    thread_id TEXT,
    turn_id TEXT,
    logical_turn_id TEXT REFERENCES logical_turns(id) ON DELETE RESTRICT,
    item_id TEXT,
    operation TEXT NOT NULL CHECK(operation IN ('Command','FileChange','Permissions')),
    params_json TEXT NOT NULL,
    available_decisions_json TEXT,
    command_text TEXT,
    cwd TEXT,
    file_paths_json TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL CHECK(state IN (
      'Pending','Approved','Denied','Expired','Cancelled','Orphaned'
    )),
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    delivery_attempted_at TEXT,
    delivered_at TEXT,
    resolved_at TEXT,
    responded_at TEXT,
    resolving_inbound_message_id TEXT REFERENCES inbound_messages(id) ON DELETE RESTRICT,
    response_json TEXT,
    delivery_error TEXT,
    payload_redacted_at TEXT,
    UNIQUE(connection_id, rpc_request_id_json)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS approval_pending_fifo
    ON approval_requests(state, delivered_at, requested_at)`,
  `CREATE TABLE IF NOT EXISTS handled_approval_messages (
    inbound_message_id TEXT PRIMARY KEY REFERENCES inbound_messages(id) ON DELETE RESTRICT,
    approval_id TEXT REFERENCES approval_requests(id) ON DELETE RESTRICT,
    command TEXT NOT NULL CHECK(command IN ('/yes','/no','invalid')),
    outcome TEXT NOT NULL CHECK(outcome IN ('Resolved','NoPending','Invalid')),
    handled_at TEXT NOT NULL
  ) STRICT`,
  ...scheduleMigrationStatements,
] as const;

export { migrationStatements, SCHEMA_VERSION };
