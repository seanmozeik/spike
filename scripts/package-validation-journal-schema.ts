import { Database, type SQLQueryBindings } from 'bun:sqlite';

import { legacyCreatedAt } from './package-validation-journal-records';

const trackedIndexes = new Set([
  'attachments_inbound_message',
  'attachments_staged_path',
  'inbound_messages_message_guid',
  'inbound_messages_messages_rowid',
  'inbound_messages_source',
  'scheduled_runs_state',
  'schedules_due',
]);
const trackedTables = new Set(['schedule_tool_calls', 'scheduled_runs', 'schedules']);
const trackedApprovalObjects = new Set([
  'approval_pending_fifo',
  'approval_requests',
  'handled_approval_messages',
]);

interface JournalSchemaContract {
  readonly accountColumns: readonly string[];
  readonly approvalObjects: readonly string[];
  readonly attachmentColumns: readonly string[];
  readonly inboundColumns: readonly string[];
  readonly indexes: readonly string[];
  readonly outboundIndexSql: {
    readonly failureNotice: string | null;
    readonly final: string | null;
  };
  readonly tables: readonly string[];
}

interface CurrentMigrationContract extends JournalSchemaContract {
  readonly account: Record<string, unknown> | null;
  readonly attachment: Record<string, unknown> | null;
  readonly message: Record<string, unknown> | null;
}

const names = (database: Database, query: string): readonly string[] =>
  database
    .query<{ name: string }, SQLQueryBindings[]>(query)
    .all()
    .map(({ name }) => name)
    .toSorted();

const columns = (database: Database, table: string): readonly string[] =>
  names(database, `SELECT name FROM pragma_table_info('${table}')`);

const indexSql = (database: Database, name: string): string | null => {
  const row = database
    .query<{ sql: string | null }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    )
    .get(name);
  return row?.sql?.replaceAll(/\s+/gu, ' ').trim() ?? null;
};

const schemaContract = (database: Database): JournalSchemaContract => ({
  accountColumns: columns(database, 'account_observations'),
  approvalObjects: names(database, 'SELECT name FROM sqlite_master').filter((name) =>
    trackedApprovalObjects.has(name),
  ),
  attachmentColumns: columns(database, 'attachments'),
  inboundColumns: columns(database, 'inbound_messages'),
  indexes: names(database, "SELECT name FROM sqlite_master WHERE type = 'index'").filter((name) =>
    trackedIndexes.has(name),
  ),
  outboundIndexSql: {
    failureNotice: indexSql(database, 'outbound_one_failure_notice'),
    final: indexSql(database, 'outbound_one_final'),
  },
  tables: names(database, "SELECT name FROM sqlite_master WHERE type = 'table'").filter((name) =>
    trackedTables.has(name),
  ),
});

const readJournalSchemaContract = (databasePath: string): JournalSchemaContract => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return schemaContract(database);
  } finally {
    database.close();
  }
};

const readCurrentMigrationContract = (databasePath: string): CurrentMigrationContract => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return {
      ...schemaContract(database),
      account: database
        .query<Record<string, unknown>, []>(
          "SELECT mode, selected_at FROM account_observations WHERE account_id = 'legacy-account'",
        )
        .get(),
      attachment: database
        .query<Record<string, unknown>, []>(
          "SELECT failure_code, ordinal FROM attachments WHERE id = 'legacy-attachment'",
        )
        .get(),
      message: database
        .query<Record<string, unknown>, []>(
          "SELECT source_kind, source_id FROM inbound_messages WHERE id = 'legacy-message'",
        )
        .get(),
    };
  } finally {
    database.close();
  }
};

const rebuildLegacyInboundMessages = (database: Database): void => {
  database.run(
    `CREATE TABLE inbound_messages_legacy (
      id TEXT PRIMARY KEY,
      message_guid TEXT NOT NULL UNIQUE,
      messages_rowid INTEGER NOT NULL UNIQUE,
      chat_guid TEXT NOT NULL,
      handle TEXT NOT NULL,
      service TEXT NOT NULL CHECK(service = 'iMessage'),
      text TEXT,
      sent_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      payload_redacted_at TEXT
    ) STRICT`,
  );
  database.run(
    `INSERT INTO inbound_messages_legacy(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at,
       observed_at, payload_redacted_at
     ) SELECT id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at,
              observed_at, payload_redacted_at
       FROM inbound_messages WHERE source_kind = 'Messages'`,
  );
  database.run('DROP TABLE inbound_messages');
  database.run('ALTER TABLE inbound_messages_legacy RENAME TO inbound_messages');
};

const downgradeModernJournalSchema = (database: Database): void => {
  database.run('DROP TABLE IF EXISTS schedule_tool_calls');
  database.run('DROP TABLE IF EXISTS scheduled_runs');
  database.run('DROP TABLE IF EXISTS schedules');
  for (const index of trackedIndexes) {
    database.run(`DROP INDEX IF EXISTS ${index}`);
  }
  database.run('DROP INDEX IF EXISTS outbound_one_failure_notice');
  database.run('DROP INDEX IF EXISTS outbound_one_final');
  database.run(
    `CREATE UNIQUE INDEX outbound_one_final
     ON outbound_messages(logical_turn_id, message_kind)
     WHERE message_kind = 'Final'`,
  );
  rebuildLegacyInboundMessages(database);
  database.run('ALTER TABLE attachments DROP COLUMN ordinal');
  database.run('ALTER TABLE attachments DROP COLUMN failure_code');
  database.run('ALTER TABLE account_observations DROP COLUMN selected_at');
  database.run('ALTER TABLE account_observations DROP COLUMN mode');
};

const seedCurrentScheduleRecords = (databasePath: string): void => {
  const database = new Database(databasePath, { strict: true });
  try {
    database.run(
      `INSERT INTO schedules(
         id, name, prompt, kind, one_shot_at, rrule, timezone, state, next_due_at,
         created_at, updated_at, revision, last_run_at
       ) VALUES (
         'legacy-schedule', 'Preserved schedule', 'preserve scheduled work', 'OneShot', ?,
         NULL, 'Europe/London', 'Completed', NULL, ?, ?, 2, ?
       )`,
      [legacyCreatedAt, legacyCreatedAt, legacyCreatedAt, legacyCreatedAt],
    );
    database.run(
      `INSERT INTO inbound_messages(
         id, source_kind, source_id, message_guid, messages_rowid, chat_guid, handle, service,
         text, sent_at, observed_at
       ) VALUES (
         'legacy-schedule-message', 'ScheduleRun', 'legacy-schedule-run', NULL, NULL,
         'iMessage;-;spike@example.com', 'spike@example.com', 'Schedule',
         'preserve scheduled work', ?, ?
       )`,
      [legacyCreatedAt, legacyCreatedAt],
    );
    database.run(
      `INSERT INTO scheduled_runs(
         id, schedule_id, scheduled_for, state, inbound_message_id, logical_turn_id,
         enqueued_at, started_at, completed_at
       ) VALUES (
         'legacy-schedule-run', 'legacy-schedule', ?, 'Completed',
         'legacy-schedule-message', 'legacy-turn', ?, ?, ?
       )`,
      [legacyCreatedAt, legacyCreatedAt, legacyCreatedAt, legacyCreatedAt],
    );
    database.run(
      `INSERT INTO schedule_tool_calls(
         call_id, request_hash, response_json, success, created_at
       ) VALUES (
         'legacy-schedule-call', 'legacy-request-hash', '{"success":true}', 1, ?
       )`,
      [legacyCreatedAt],
    );
  } finally {
    database.close();
  }
};

const expectedVersionOneSchema = {
  accountColumns: ['account_id', 'id', 'observed_at', 'reset_at', 'usable', 'usage_json'],
  approvalObjects: [],
  attachmentColumns: [
    'attachment_guid',
    'content_hash',
    'created_at',
    'filename',
    'id',
    'inbound_message_id',
    'mime_type',
    'payload_redacted_at',
    'source_path',
    'staged_path',
    'state',
    'total_bytes',
    'transfer_name',
    'uti',
  ],
  inboundColumns: [
    'chat_guid',
    'handle',
    'id',
    'message_guid',
    'messages_rowid',
    'observed_at',
    'payload_redacted_at',
    'sent_at',
    'service',
    'text',
  ],
  indexes: [],
  outboundIndexSql: {
    failureNotice: null,
    final:
      "CREATE UNIQUE INDEX outbound_one_final ON outbound_messages(logical_turn_id, message_kind) WHERE message_kind = 'Final'",
  },
  tables: [],
} satisfies JournalSchemaContract;

const expectedCurrentMigrationContract = {
  account: { mode: 'Capacity', selected_at: null },
  accountColumns: [...expectedVersionOneSchema.accountColumns, 'mode', 'selected_at'].toSorted(),
  approvalObjects: [...trackedApprovalObjects].toSorted(),
  attachment: { failure_code: null, ordinal: 0 },
  attachmentColumns: [
    ...expectedVersionOneSchema.attachmentColumns,
    'failure_code',
    'ordinal',
  ].toSorted(),
  inboundColumns: [
    ...expectedVersionOneSchema.inboundColumns,
    'source_id',
    'source_kind',
  ].toSorted(),
  indexes: [...trackedIndexes].toSorted(),
  message: { source_id: 'legacy-message-guid', source_kind: 'Messages' },
  outboundIndexSql: {
    failureNotice:
      "CREATE UNIQUE INDEX outbound_one_failure_notice ON outbound_messages(logical_turn_id, source_kind) WHERE source_kind = 'TurnFailureNotice'",
    final:
      "CREATE UNIQUE INDEX outbound_one_final ON outbound_messages(logical_turn_id, message_kind) WHERE message_kind = 'Final' AND source_kind = 'CodexAgentItem'",
  },
  tables: [...trackedTables].toSorted(),
} satisfies CurrentMigrationContract;

export {
  downgradeModernJournalSchema,
  expectedCurrentMigrationContract,
  expectedVersionOneSchema,
  readCurrentMigrationContract,
  readJournalSchemaContract,
  seedCurrentScheduleRecords,
};
export type { CurrentMigrationContract, JournalSchemaContract };
