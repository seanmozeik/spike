import { Database } from 'bun:sqlite';

import { SCHEMA_VERSION } from '../src/journal/migrations';
import { applyMigrations } from '../src/journal/migrations-runner';
import {
  legacyCreatedAt,
  legacyStaleAttemptStartedAt,
  readPreservedJournalRecords,
  type PreservedJournalRecords,
} from './package-validation-journal-records';
import { downgradeModernJournalSchema } from './package-validation-journal-schema';

const createCurrentJournal = (databasePath: string): void => {
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    database.run('PRAGMA journal_mode = WAL');
    applyMigrations(database);
  } finally {
    database.close();
  }
};

const replaceGenerationsWithVersionOne = (database: Database): void => {
  database.run(
    `CREATE TABLE generations_v1 (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('Current','Superseded')),
      created_at TEXT NOT NULL,
      superseded_at TEXT
    ) STRICT`,
  );
  database.run('DROP TABLE generations');
  database.run('ALTER TABLE generations_v1 RENAME TO generations');
};

const seedVersionOneRecords = (database: Database): void => {
  database.run(
    "INSERT INTO generations(id, sequence, state, created_at) VALUES ('legacy-generation', 1, 'Current', ?)",
    [legacyCreatedAt],
  );
  database.run(
    `INSERT INTO logical_turns(
      id, generation_id, sequence, state, correlation_id, created_at, completed_at
    ) VALUES ('legacy-turn', 'legacy-generation', 1, 'Completed', 'legacy-correlation', ?, ?)`,
    [legacyCreatedAt, legacyCreatedAt],
  );
  database.run(
    `INSERT INTO inbound_messages(
      id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
    ) VALUES (
      'legacy-message', 'legacy-message-guid', 1, 'iMessage;-;spike@example.com',
      'spike@example.com', 'iMessage', 'preserve this journal row', ?, ?
    )`,
    [legacyCreatedAt, legacyCreatedAt],
  );
  database.run(
    `INSERT INTO attachments(
      id, inbound_message_id, attachment_guid, state, filename, transfer_name, mime_type,
      uti, total_bytes, source_path, staged_path, content_hash, created_at
    ) VALUES (
      'legacy-attachment', 'legacy-message', 'legacy-attachment-guid', 'Assigned',
      '/legacy/active.png', 'active.png', 'image/png', 'public.png', 128,
      '/legacy/source.png', '/legacy/staged.png', 'legacy-attachment-hash', ?
    )`,
    [legacyCreatedAt],
  );
  database.run(
    `INSERT INTO input_batches(id, logical_turn_id, kind, fingerprint, created_at)
     VALUES ('legacy-batch', 'legacy-turn', 'Initial', 'legacy-fingerprint', ?)`,
    [legacyCreatedAt],
  );
  database.run(
    `INSERT INTO input_batch_messages(input_batch_id, inbound_message_id, ordinal)
     VALUES ('legacy-batch', 'legacy-message', 0)`,
  );
  database.run(
    `INSERT INTO codex_attempts(id, logical_turn_id, state, started_at, finished_at)
     VALUES ('legacy-attempt', 'legacy-turn', 'Completed', ?, ?)`,
    [legacyCreatedAt, legacyCreatedAt],
  );
  database.run(
    `INSERT INTO codex_attempts(id, logical_turn_id, state, started_at)
     VALUES ('stale-terminal-attempt', 'legacy-turn', 'Prepared', ?)`,
    [legacyStaleAttemptStartedAt],
  );
  database.run(
    `INSERT INTO outbound_messages(
      id, logical_turn_id, source_kind, source_id, message_kind, text, state, created_at,
      delivered_at
    ) VALUES (
      'legacy-outbound', 'legacy-turn', 'CodexAgentItem', 'legacy-item', 'Final',
      'preserve outbound delivery', 'Delivered', ?, ?
    )`,
    [legacyCreatedAt, legacyCreatedAt],
  );
  database.run(
    `INSERT INTO outbound_chunks(
      id, outbound_message_id, ordinal, text, messages_rowid, message_guid, state
    ) VALUES (
      'legacy-chunk', 'legacy-outbound', 0, 'preserve outbound delivery', 2,
      'legacy-outbound-guid', 'Reconciled'
    )`,
  );
  database.run(
    `INSERT INTO delivery_attempts(
      id, outbound_chunk_id, attempt_number, state, started_at, finished_at, error
    ) VALUES (
      'legacy-delivery-attempt', 'legacy-chunk', 1, 'Reconciled', ?, ?, NULL
    )`,
    [legacyCreatedAt, legacyCreatedAt],
  );
  database.run(
    `INSERT INTO failures(correlation_id, operation, error_tag, message, created_at)
     VALUES ('legacy-correlation', 'package-validation', 'Fixture', 'preserve failure row', ?)`,
    [legacyCreatedAt],
  );
  database.run(
    `INSERT INTO account_observations(
      account_id, observed_at, usable, usage_json, reset_at
    ) VALUES ('legacy-account', ?, 0, '{"remainingPercent":0}', ?)`,
    [legacyCreatedAt, legacyCreatedAt],
  );
  database.run(
    `INSERT INTO scheduler_state(
      singleton, generation_id, active_logical_turn_id, active_codex_turn_id,
      active_acknowledged, timer_deadline_at, updated_at, codex_thread_id
    ) VALUES (1, 'legacy-generation', NULL, NULL, 0, NULL, ?, 'legacy-thread')`,
    [legacyCreatedAt],
  );
};

const downgradeToVersionOne = (databasePath: string): void => {
  const database = new Database(databasePath, { strict: true });
  try {
    database.run('PRAGMA foreign_keys = OFF');
    database.run('PRAGMA legacy_alter_table = ON');
    database.run('DROP TABLE handled_approval_messages');
    database.run('DROP INDEX approval_pending_fifo');
    database.run('DROP TABLE approval_requests');
    downgradeModernJournalSchema(database);
    database.run('DROP INDEX codex_attempts_one_per_input_batch');
    database.run('DROP INDEX input_batches_turn_sequence');
    database.run('ALTER TABLE codex_attempts DROP COLUMN input_batch_id');
    database.run('ALTER TABLE input_batches DROP COLUMN sequence');
    database.run('ALTER TABLE scheduler_state ADD COLUMN codex_thread_id TEXT');
    database.run('ALTER TABLE scheduler_state DROP COLUMN generation_broken');
    database.run('ALTER TABLE delivery_attempts DROP COLUMN frontier_rowid');
    database.run('ALTER TABLE logical_turns DROP COLUMN acknowledged_at');
    database.run('ALTER TABLE codex_attempts DROP COLUMN submission_kind');
    database.run('ALTER TABLE codex_attempts DROP COLUMN frontier_json');
    database.run('ALTER TABLE codex_attempts DROP COLUMN input_fingerprint');
    replaceGenerationsWithVersionOne(database);
    database.run('DELETE FROM schema_meta');
    database.run(
      "INSERT INTO schema_meta(version, applied_at) VALUES (1, '2026-07-19T00:00:00.000Z')",
    );
    seedVersionOneRecords(database);
  } finally {
    database.run('PRAGMA legacy_alter_table = OFF');
    database.run('PRAGMA foreign_keys = ON');
    database.close();
  }
};

const createOldestJournal = (databasePath: string): void => {
  createCurrentJournal(databasePath);
  downgradeToVersionOne(databasePath);
};

const seedCurrentApprovalRecord = (databasePath: string): void => {
  const database = new Database(databasePath, { strict: true });
  try {
    database.run(
      `INSERT INTO approval_requests(
        id, connection_id, rpc_request_id_json, method, thread_id, turn_id, logical_turn_id,
        item_id, operation, params_json, available_decisions_json, command_text, cwd,
        file_paths_json, reason, state, requested_at, expires_at, delivery_attempted_at,
        delivered_at, resolved_at, responded_at, resolving_inbound_message_id, response_json,
        delivery_error
      ) VALUES (
        'legacy-approval', 'legacy-connection', '"legacy-rpc"', 'execCommandApproval',
        'legacy-thread', 'legacy-codex-turn', 'legacy-turn', 'legacy-item', 'Command',
        '{"command":"echo legacy"}', '["accept","decline"]', 'echo legacy', '/legacy/work',
        '[]', 'preserve approval reason', 'Denied', ?, ?, ?, ?, ?, ?, NULL,
        '{"decision":"decline"}', NULL
      )`,
      [
        legacyCreatedAt,
        legacyCreatedAt,
        legacyCreatedAt,
        legacyCreatedAt,
        legacyCreatedAt,
        legacyCreatedAt,
      ],
    );
  } finally {
    database.close();
  }
};

const preservedJournalRecords = (databasePath: string): PreservedJournalRecords => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return readPreservedJournalRecords(database);
  } finally {
    database.close();
  }
};

const journalSnapshot = (databasePath: string): string => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return JSON.stringify({
      accountObservations: database.query('SELECT * FROM account_observations ORDER BY id').all(),
      approvals: database.query('SELECT * FROM approval_requests ORDER BY id').all(),
      attachments: database.query('SELECT * FROM attachments ORDER BY id').all(),
      attempts: database.query('SELECT * FROM codex_attempts ORDER BY id').all(),
      batchMessages: database
        .query('SELECT * FROM input_batch_messages ORDER BY input_batch_id, ordinal')
        .all(),
      batches: database.query('SELECT * FROM input_batches ORDER BY id').all(),
      deliveryAttempts: database.query('SELECT * FROM delivery_attempts ORDER BY id').all(),
      failures: database.query('SELECT * FROM failures ORDER BY id').all(),
      generations: database.query('SELECT * FROM generations ORDER BY id').all(),
      messages: database.query('SELECT * FROM inbound_messages ORDER BY id').all(),
      outboundChunks: database.query('SELECT * FROM outbound_chunks ORDER BY id').all(),
      outboundMessages: database.query('SELECT * FROM outbound_messages ORDER BY id').all(),
      scheduleToolCalls: database.query('SELECT * FROM schedule_tool_calls ORDER BY call_id').all(),
      scheduledRuns: database.query('SELECT * FROM scheduled_runs ORDER BY id').all(),
      scheduler: database.query('SELECT * FROM scheduler_state ORDER BY singleton').all(),
      schedulerColumns: database.query('PRAGMA table_info(scheduler_state)').all(),
      schedules: database.query('SELECT * FROM schedules ORDER BY id').all(),
      schema: database.query('SELECT * FROM schema_meta ORDER BY version').all(),
      schemaIndexes: database
        .query("SELECT name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all(),
      turns: database.query('SELECT * FROM logical_turns ORDER BY id').all(),
    });
  } finally {
    database.close();
  }
};

const journalVersion = (databasePath: string): number => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return (
      database
        .query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_meta')
        .get()?.version ?? 0
    );
  } finally {
    database.close();
  }
};

const currentSchemaVersion = SCHEMA_VERSION;

export {
  createCurrentJournal,
  createOldestJournal,
  currentSchemaVersion,
  journalSnapshot,
  journalVersion,
  preservedJournalRecords,
  seedCurrentApprovalRecord,
};
