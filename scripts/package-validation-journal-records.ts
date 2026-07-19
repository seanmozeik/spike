import type { Database } from 'bun:sqlite';

interface PreservedJournalRecords {
  readonly accountObservations: readonly Record<string, unknown>[];
  readonly attempts: readonly Record<string, unknown>[];
  readonly approvals: readonly Record<string, unknown>[];
  readonly attachments: readonly Record<string, unknown>[];
  readonly batchMessages: readonly Record<string, unknown>[];
  readonly batches: readonly Record<string, unknown>[];
  readonly deliveryAttempts: readonly Record<string, unknown>[];
  readonly failures: readonly Record<string, unknown>[];
  readonly generationThread: string | null;
  readonly generations: readonly Record<string, unknown>[];
  readonly messages: readonly Record<string, unknown>[];
  readonly outboundChunks: readonly Record<string, unknown>[];
  readonly outboundMessages: readonly Record<string, unknown>[];
  readonly scheduleToolCalls: readonly Record<string, unknown>[];
  readonly scheduledRuns: readonly Record<string, unknown>[];
  readonly scheduler: readonly Record<string, unknown>[];
  readonly schedules: readonly Record<string, unknown>[];
  readonly turns: readonly Record<string, unknown>[];
}

const legacyCreatedAt = '2026-07-19T00:01:00.000Z';
const legacyStaleAttemptStartedAt = '2026-07-19T00:00:30.000Z';

const hasColumn = (database: Database, table: string, column: string): boolean =>
  database
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some(({ name }) => name === column);

const hasTable = (database: Database, table: string): boolean =>
  database
    .query<{ present: number }, [string]>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table) !== null;

const rows = (database: Database, sql: string): readonly Record<string, unknown>[] =>
  database.query<Record<string, unknown>, []>(sql).all();

const rowsIfTable = (
  database: Database,
  table: string,
  sql: string,
): readonly Record<string, unknown>[] => (hasTable(database, table) ? rows(database, sql) : []);

const generationThread = (database: Database): string | null => {
  const query = hasColumn(database, 'generations', 'codex_thread_id')
    ? "SELECT codex_thread_id FROM generations WHERE id = 'legacy-generation'"
    : "SELECT codex_thread_id FROM scheduler_state WHERE generation_id = 'legacy-generation'";
  return (
    database.query<{ codex_thread_id: string | null }, []>(query).get()?.codex_thread_id ?? null
  );
};

const readPreservedJournalRecords = (database: Database): PreservedJournalRecords => ({
  accountObservations: rows(
    database,
    `SELECT id, account_id, observed_at, usable, usage_json, reset_at
     FROM account_observations ORDER BY id`,
  ),
  approvals: rowsIfTable(
    database,
    'approval_requests',
    `SELECT id, connection_id, rpc_request_id_json, method, thread_id, turn_id,
            logical_turn_id, item_id, operation, params_json, available_decisions_json,
            command_text, cwd, file_paths_json, reason, state, requested_at, expires_at,
            delivery_attempted_at, delivered_at, resolved_at, responded_at,
            resolving_inbound_message_id, response_json, delivery_error
     FROM approval_requests ORDER BY id`,
  ),
  attachments: rows(
    database,
    `SELECT id, inbound_message_id, attachment_guid, state, filename, transfer_name,
            mime_type, uti, total_bytes, source_path, staged_path, content_hash, created_at,
            payload_redacted_at
     FROM attachments ORDER BY id`,
  ),
  attempts: rows(
    database,
    `SELECT id, logical_turn_id, account_id, state, codex_thread_id, codex_turn_id,
            started_at, finished_at FROM codex_attempts ORDER BY id`,
  ),
  batchMessages: rows(
    database,
    `SELECT input_batch_id, inbound_message_id, ordinal
     FROM input_batch_messages ORDER BY input_batch_id, ordinal`,
  ),
  batches: rows(
    database,
    `SELECT id, logical_turn_id, kind, fingerprint, created_at
     FROM input_batches ORDER BY id`,
  ),
  deliveryAttempts: rows(
    database,
    `SELECT id, outbound_chunk_id, attempt_number, state, started_at, finished_at, error
     FROM delivery_attempts ORDER BY id`,
  ),
  failures: rows(
    database,
    `SELECT id, correlation_id, operation, error_tag, message, details_json, created_at
     FROM failures ORDER BY id`,
  ),
  generationThread: generationThread(database),
  generations: rows(
    database,
    `SELECT id, sequence, state, created_at, superseded_at FROM generations ORDER BY id`,
  ),
  messages: rows(
    database,
    `SELECT id, ${
      hasColumn(database, 'inbound_messages', 'source_kind')
        ? 'source_kind, source_id'
        : "'Messages' AS source_kind, message_guid AS source_id"
    }, message_guid, messages_rowid, chat_guid, handle, service, text,
            sent_at, observed_at FROM inbound_messages ORDER BY id`,
  ),
  outboundChunks: rows(
    database,
    `SELECT id, outbound_message_id, ordinal, text, messages_rowid, message_guid, state
     FROM outbound_chunks ORDER BY id`,
  ),
  outboundMessages: rows(
    database,
    `SELECT id, logical_turn_id, source_kind, source_id, message_kind, text, state,
            created_at, delivered_at
     FROM outbound_messages ORDER BY id`,
  ),
  scheduleToolCalls: rowsIfTable(
    database,
    'schedule_tool_calls',
    `SELECT call_id, request_hash, response_json, success, created_at, payload_redacted_at
     FROM schedule_tool_calls ORDER BY call_id`,
  ),
  scheduledRuns: rowsIfTable(
    database,
    'scheduled_runs',
    `SELECT id, schedule_id, scheduled_for, state, inbound_message_id, logical_turn_id,
            enqueued_at, started_at, completed_at, error, payload_redacted_at
     FROM scheduled_runs ORDER BY id`,
  ),
  scheduler: rows(
    database,
    `SELECT singleton, generation_id, active_logical_turn_id, active_codex_turn_id,
            active_acknowledged, timer_deadline_at, updated_at
     FROM scheduler_state ORDER BY singleton`,
  ),
  schedules: rowsIfTable(
    database,
    'schedules',
    `SELECT id, name, prompt, kind, one_shot_at, rrule, timezone, state, next_due_at,
            created_at, updated_at, revision, last_run_at, payload_redacted_at
     FROM schedules ORDER BY id`,
  ),
  turns: rows(
    database,
    `SELECT id, generation_id, sequence, state, correlation_id, created_at, completed_at
     FROM logical_turns ORDER BY id`,
  ),
});

export { legacyCreatedAt, legacyStaleAttemptStartedAt, readPreservedJournalRecords };
export type { PreservedJournalRecords };
