import type { Database } from 'bun:sqlite';

import { reconcileClaimedObservedAttachments } from './attachment-reconciliation';
import {
  ensureInputBatchIdentityIndexes,
  migrateInputBatchIdentity,
} from './input-batch-migration';
import { ATTACHMENTS_INBOUND_MESSAGE_INDEX } from './recovery-query';

const DELIVERY_FRONTIER_VERSION = 5;
const CANONICAL_GENERATION_THREAD_VERSION = 7;
const BROKEN_GENERATION_STATE_VERSION = 8;
const TERMINAL_ATTEMPT_STATE_VERSION = 9;
const APPROVAL_PAYLOAD_RETENTION_VERSION = 11;
const INPUT_BATCH_IDENTITY_VERSION = 12;
const FAILURE_NOTICE_IDENTITY_VERSION = 13;
const ACCOUNT_SELECTION_VERSION = 14;
const ATTACHMENT_STAGING_VERSION = 15;
const RECOVERY_QUERY_INDEX_VERSION = 16;
const DURABLE_SCHEDULES_VERSION = 17;

const needsDurableScheduleInboundRebuild = (previousVersion: number): boolean =>
  previousVersion > 0 && previousVersion < DURABLE_SCHEDULES_VERSION;

const hasColumn = (database: Database, table: string, column: string): boolean =>
  database
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some(({ name }) => name === column);

const migrateFailureNoticeIdentity = (database: Database): void => {
  database.run('DROP INDEX IF EXISTS outbound_one_final');
  database.run(
    `CREATE UNIQUE INDEX outbound_one_final
     ON outbound_messages(logical_turn_id, message_kind)
     WHERE message_kind = 'Final' AND source_kind = 'CodexAgentItem'`,
  );
  database.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS outbound_one_failure_notice
     ON outbound_messages(logical_turn_id, source_kind)
     WHERE source_kind = 'TurnFailureNotice'`,
  );
};

const migrateInitialSchema = (database: Database, previousVersion: number): void => {
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
};

const migrateSchedulerSchema = (database: Database, previousVersion: number): void => {
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
};

const migrateTerminalAttempts = (database: Database, previousVersion: number): void => {
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
};

const migrateApprovalPayloadRetention = (database: Database, previousVersion: number): void => {
  if (
    previousVersion > 0 &&
    previousVersion < APPROVAL_PAYLOAD_RETENTION_VERSION &&
    !hasColumn(database, 'approval_requests', 'payload_redacted_at')
  ) {
    database.run('ALTER TABLE approval_requests ADD COLUMN payload_redacted_at TEXT');
  }
};

const migrateIdentitySchema = (database: Database, previousVersion: number): void => {
  if (previousVersion > 0 && previousVersion < INPUT_BATCH_IDENTITY_VERSION) {
    migrateInputBatchIdentity(database);
  }
  if (previousVersion > 0 && previousVersion < FAILURE_NOTICE_IDENTITY_VERSION) {
    migrateFailureNoticeIdentity(database);
  }
  ensureInputBatchIdentityIndexes(database);
};

const migrateAccountSelection = (database: Database, previousVersion: number): void => {
  if (previousVersion <= 0 || previousVersion >= ACCOUNT_SELECTION_VERSION) {
    return;
  }
  if (!hasColumn(database, 'account_observations', 'mode')) {
    database.run(
      "ALTER TABLE account_observations ADD COLUMN mode TEXT NOT NULL DEFAULT 'Available' CHECK(mode IN ('Available','Capacity','Authentication'))",
    );
    database.run(
      "UPDATE account_observations SET mode = CASE usable WHEN 1 THEN 'Available' ELSE 'Capacity' END",
    );
  }
  if (!hasColumn(database, 'account_observations', 'selected_at')) {
    database.run('ALTER TABLE account_observations ADD COLUMN selected_at TEXT');
  }
};

const migrateAttachmentStaging = (database: Database, previousVersion: number): void => {
  if (previousVersion <= 0 || previousVersion >= ATTACHMENT_STAGING_VERSION) {
    return;
  }
  if (!hasColumn(database, 'attachments', 'failure_code')) {
    database.run('ALTER TABLE attachments ADD COLUMN failure_code TEXT');
  }
  if (!hasColumn(database, 'attachments', 'ordinal')) {
    database.run(
      'ALTER TABLE attachments ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal >= 0)',
    );
  }
  database.run(
    `WITH ranked AS (
       SELECT id, ROW_NUMBER() OVER (
         PARTITION BY inbound_message_id ORDER BY rowid
       ) - 1 AS ordinal
       FROM attachments
     )
     UPDATE attachments SET ordinal = (
       SELECT ranked.ordinal FROM ranked WHERE ranked.id = attachments.id
     )`,
  );
  reconcileClaimedObservedAttachments(database);
};

const migrateRecoveryQueryIndexes = (database: Database, previousVersion: number): void => {
  if (previousVersion <= 0 || previousVersion >= RECOVERY_QUERY_INDEX_VERSION) {
    return;
  }
  database.run(ATTACHMENTS_INBOUND_MESSAGE_INDEX);
};

const createInboundIdentityIndexes = (database: Database): void => {
  database.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_message_guid
     ON inbound_messages(message_guid) WHERE source_kind = 'Messages'`,
  );
  database.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_messages_rowid
     ON inbound_messages(messages_rowid) WHERE source_kind = 'Messages'`,
  );
  database.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_source
     ON inbound_messages(source_kind, source_id) WHERE source_id IS NOT NULL`,
  );
};

const rebuildInboundMessages = (database: Database): void => {
  database.run(
    `CREATE TABLE inbound_messages_v17 (
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
  );
  database.run(
    `INSERT INTO inbound_messages_v17(
       id, source_kind, source_id, message_guid, messages_rowid, chat_guid, handle,
       service, text, sent_at, observed_at, payload_redacted_at
     ) SELECT id, 'Messages', message_guid, message_guid, messages_rowid, chat_guid, handle,
              service, text, sent_at, observed_at, payload_redacted_at
       FROM inbound_messages`,
  );
  database.run('DROP TABLE inbound_messages');
  database.run('ALTER TABLE inbound_messages_v17 RENAME TO inbound_messages');
};

const migrateDurableSchedules = (database: Database, previousVersion: number): void => {
  if (needsDurableScheduleInboundRebuild(previousVersion)) {
    rebuildInboundMessages(database);
  }
  if (!hasColumn(database, 'schedules', 'revision')) {
    database.run(
      'ALTER TABLE schedules ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)',
    );
  }
  createInboundIdentityIndexes(database);
};

const applyVersionedMigrations = (database: Database, previousVersion: number): void => {
  migrateInitialSchema(database, previousVersion);
  migrateSchedulerSchema(database, previousVersion);
  migrateTerminalAttempts(database, previousVersion);
  migrateApprovalPayloadRetention(database, previousVersion);
  migrateIdentitySchema(database, previousVersion);
  migrateAccountSelection(database, previousVersion);
  migrateAttachmentStaging(database, previousVersion);
  migrateRecoveryQueryIndexes(database, previousVersion);
  migrateDurableSchedules(database, previousVersion);
};

export { applyVersionedMigrations, needsDurableScheduleInboundRebuild };
