import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalInputFingerprint } from '../src/codex/reconcile';

const CREATED_AT = '2026-07-14T11:59:50.000Z';
const FAILURE_NOTICE_SCHEMA_VERSION = 13;
const ACCOUNT_SELECTION_SCHEMA_VERSION = 14;
const ACTIVE_INPUT =
  'active request\n[Attachment: active.png (image/png)]\n[Attachment: active-two.jpg (image/jpeg)]';
const TERMINAL_ROW_ID = 3;

const insertInbound = (database: Database, id: string, rowId: number, text: string): void => {
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (?, ?, ?, 'any;-;+15555550199', '+15555550199', 'iMessage', ?, ?, ?)`,
    [id, `guid-${id}`, rowId, text, CREATED_AT, CREATED_AT],
  );
};

const insertAttachment = (
  database: Database,
  id: string,
  inboundId: string,
  filename: string,
): void => {
  const mimeType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
  database.run(
    `INSERT INTO attachments(
       id, inbound_message_id, attachment_guid, state, filename, transfer_name,
       mime_type, uti, total_bytes, source_path, created_at
     ) VALUES (?, ?, ?, 'Observed', ?, ?, ?, 'public.image', 4, ?, ?)`,
    [id, inboundId, `guid-${id}`, filename, filename, mimeType, filename, CREATED_AT],
  );
};

const downgradeAttachmentSchema = (database: Database): void => {
  database.run('PRAGMA foreign_keys = ON');
  database.run('DROP INDEX IF EXISTS attachments_inbound_message');
  database.run('DROP INDEX IF EXISTS attachments_staged_path');
  database.run('ALTER TABLE attachments DROP COLUMN ordinal');
  database.run('ALTER TABLE attachments DROP COLUMN failure_code');
};

const downgradeAccountSchema = (database: Database): void => {
  database.run('ALTER TABLE account_observations DROP COLUMN selected_at');
  database.run('ALTER TABLE account_observations DROP COLUMN mode');
  database.run(
    `INSERT INTO account_observations(
       account_id, observed_at, usable, usage_json, reset_at
     ) VALUES ('legacy-account', ?, 0, NULL, NULL)`,
    [CREATED_AT],
  );
};

const seedTurns = (database: Database): void => {
  database.run(
    `INSERT INTO generations(
       id, sequence, state, created_at, codex_thread_id
     ) VALUES ('generation-v13', 1, 'Current', ?, 'thread-v13')`,
    [CREATED_AT],
  );
  database.run(
    `INSERT INTO logical_turns(
       id, generation_id, sequence, state, correlation_id, created_at, completed_at
     ) VALUES
       ('active-v13', 'generation-v13', 1, 'Running', 'active-correlation', ?, NULL),
       ('terminal-v13', 'generation-v13', 2, 'Completed', 'terminal-correlation', ?, ?)`,
    [CREATED_AT, CREATED_AT, CREATED_AT],
  );
};

const seedMessages = (database: Database): void => {
  insertInbound(database, 'active-message', 1, 'active request');
  insertInbound(database, 'pooled-message', 2, 'pooled request');
  insertInbound(database, 'terminal-message', TERMINAL_ROW_ID, 'terminal request');
  insertAttachment(database, 'active-attachment', 'active-message', 'active.png');
  insertAttachment(database, 'active-attachment-two', 'active-message', 'active-two.jpg');
  insertAttachment(database, 'pooled-attachment-one', 'pooled-message', 'photo.jpg');
  insertAttachment(database, 'pooled-attachment-two', 'pooled-message', 'fixture-two.jpg');
  insertAttachment(database, 'terminal-attachment', 'terminal-message', 'terminal.png');
};

const seedBatches = (database: Database): void => {
  database.run(
    `INSERT INTO input_batches(id, logical_turn_id, sequence, kind, fingerprint, created_at)
     VALUES
       ('active-batch', 'active-v13', 1, 'Initial', 'active-batch-fingerprint', ?),
       ('terminal-batch', 'terminal-v13', 1, 'Initial', 'terminal-batch-fingerprint', ?)`,
    [CREATED_AT, CREATED_AT],
  );
  database.run(
    `INSERT INTO input_batch_messages(input_batch_id, inbound_message_id, ordinal)
     VALUES ('active-batch', 'active-message', 0), ('terminal-batch', 'terminal-message', 0)`,
  );
  database.run(
    `INSERT INTO codex_attempts(
       id, logical_turn_id, input_batch_id, account_id, state, codex_thread_id,
       codex_turn_id, input_fingerprint, frontier_json, submission_kind, started_at
     ) VALUES (
       'active-attempt', 'active-v13', 'active-batch', 'account', 'Accepted', 'thread-v13',
       'turn-v13', ?, '{"itemIds":[],"turnIds":[]}', 'Start', ?
     )`,
    [canonicalInputFingerprint(ACTIVE_INPUT), CREATED_AT],
  );
};

type FixtureSchemaVersion =
  | typeof FAILURE_NOTICE_SCHEMA_VERSION
  | typeof ACCOUNT_SELECTION_SCHEMA_VERSION;

const seedScheduler = (database: Database, version: FixtureSchemaVersion): void => {
  database.run(
    `INSERT INTO scheduler_state(
       singleton, generation_id, active_logical_turn_id, active_codex_turn_id,
       active_acknowledged, generation_broken, timer_deadline_at, updated_at
     ) VALUES (1, 'generation-v13', 'active-v13', 'turn-v13', 0, 0, ?, ?)`,
    [CREATED_AT, CREATED_AT],
  );
  database.run("INSERT INTO scheduler_pool_messages VALUES ('pooled-message', 0)");
  database.run('DELETE FROM schema_meta');
  database.run("INSERT INTO schema_meta VALUES (?, '2026-07-14T12:00:00.000Z')", [version]);
};

const seedVersionAttachmentState = (databasePath: string, version: FixtureSchemaVersion): void => {
  const sourceRoot = path.join(path.dirname(databasePath), 'Attachments');
  writeFileSync(path.join(sourceRoot, 'fixture-two.jpg'), Buffer.from('FFD8FF00D9', 'hex'));
  const database = new Database(databasePath, { strict: true });
  try {
    downgradeAttachmentSchema(database);
    if (version === FAILURE_NOTICE_SCHEMA_VERSION) {
      downgradeAccountSchema(database);
    }
    seedTurns(database);
    seedMessages(database);
    seedBatches(database);
    seedScheduler(database, version);
  } finally {
    database.close();
  }
};

const seedVersionThirteenAttachmentState = (databasePath: string): void => {
  seedVersionAttachmentState(databasePath, FAILURE_NOTICE_SCHEMA_VERSION);
};

const seedVersionFourteenAttachmentState = (databasePath: string): void => {
  seedVersionAttachmentState(databasePath, ACCOUNT_SELECTION_SCHEMA_VERSION);
};

export { ACTIVE_INPUT, seedVersionFourteenAttachmentState, seedVersionThirteenAttachmentState };
