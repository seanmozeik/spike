import { Database } from 'bun:sqlite';

import { expect } from 'vitest';

const CREATED_AT = '2026-07-19T08:00:00.000Z';
const BATCHED_MESSAGE_ROW_ID = 10;
const POOLED_MESSAGE_ROW_ID = 20;
const PENDING_MESSAGE_ROW_ID = 30;
const INBOUND_MESSAGE_COUNT = 3;
const SCHEMA_VERSION_SIXTEEN = 16;

const databaseNames = (database: Database, query: string): readonly string[] =>
  database
    .query<{ name: string }, []>(query)
    .all()
    .map(({ name }) => name);

const schemaVersion = (database: Database): number | undefined =>
  database.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_meta').get()
    ?.version;

const rebuildInboundAsVersionSixteen = (database: Database): void => {
  database.run('PRAGMA foreign_keys = OFF');
  database.run('PRAGMA legacy_alter_table = ON');
  try {
    database.run('DROP TABLE schedule_tool_calls');
    database.run('DROP TABLE scheduled_runs');
    database.run('DROP TABLE schedules');
    database.run(
      `CREATE TABLE inbound_messages_v16 (
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
      `INSERT INTO inbound_messages_v16(
         id, message_guid, messages_rowid, chat_guid, handle, service, text,
         sent_at, observed_at, payload_redacted_at
       ) SELECT id, message_guid, messages_rowid, chat_guid, handle, service, text,
                sent_at, observed_at, payload_redacted_at
           FROM inbound_messages`,
    );
    database.run('DROP TABLE inbound_messages');
    database.run('ALTER TABLE inbound_messages_v16 RENAME TO inbound_messages');
  } finally {
    database.run('PRAGMA legacy_alter_table = OFF');
    database.run('PRAGMA foreign_keys = ON');
  }
};

const insertInbound = (
  database: Database,
  id: string,
  messageGuid: string,
  messagesRowId: number,
  text: string,
): void => {
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (?, ?, ?, 'any;-;+15555550199', '+15555550199', 'iMessage', ?, ?, ?)`,
    [id, messageGuid, messagesRowId, text, CREATED_AT, CREATED_AT],
  );
};

const seedConversationState = (database: Database): void => {
  database.run(
    `INSERT INTO inbox_cursor(chat_guid, last_rowid, last_message_guid, updated_at)
     VALUES ('any;-;+15555550199', 5, 'guid-before-fixture', ?)`,
    [CREATED_AT],
  );
  database.run(
    `INSERT INTO generations(
       id, sequence, state, created_at, codex_thread_id, prompt_version, config_version
     ) VALUES ('generation-v16', 1, 'Current', ?, 'thread-v16', 'prompt-v16', 'config-v16')`,
    [CREATED_AT],
  );
  insertInbound(
    database,
    'batched-message',
    'guid-batched',
    BATCHED_MESSAGE_ROW_ID,
    'active request',
  );
  insertInbound(database, 'pooled-message', 'guid-pooled', POOLED_MESSAGE_ROW_ID, 'pooled request');
  insertInbound(
    database,
    'pending-message',
    'guid-pending',
    PENDING_MESSAGE_ROW_ID,
    'pending request',
  );
  database.run(
    `INSERT INTO attachments(
       id, inbound_message_id, attachment_guid, state, filename, transfer_name,
       mime_type, uti, total_bytes, source_path, staged_path, content_hash,
       failure_code, ordinal, created_at
     ) VALUES
       ('staged-attachment', 'batched-message', 'attachment-guid-staged', 'Staged',
        'active.png', 'active.png', 'image/png', 'public.png', 4, 'active.png',
        '/private/staged/active.png', 'sha256-staged', NULL, 0, ?),
       ('observed-attachment', 'pending-message', 'attachment-guid-observed', 'Observed',
        'pending.jpg', 'pending.jpg', 'image/jpeg', 'public.jpeg', 8, 'pending.jpg',
        NULL, NULL, NULL, 0, ?)`,
    [CREATED_AT, CREATED_AT],
  );
};

const seedSchedulerState = (database: Database): void => {
  database.run(
    `INSERT INTO logical_turns(
       id, generation_id, sequence, state, correlation_id, created_at
     ) VALUES ('logical-v16', 'generation-v16', 1, 'Running', 'correlation-v16', ?)`,
    [CREATED_AT],
  );
  database.run(
    `INSERT INTO input_batches(id, logical_turn_id, sequence, kind, fingerprint, created_at)
     VALUES ('batch-v16', 'logical-v16', 1, 'Initial', 'fingerprint-v16', ?)`,
    [CREATED_AT],
  );
  database.run(
    `INSERT INTO input_batch_messages(input_batch_id, inbound_message_id, ordinal)
     VALUES ('batch-v16', 'batched-message', 0)`,
  );
  database.run(
    `INSERT INTO codex_attempts(
       id, logical_turn_id, input_batch_id, account_id, state, codex_thread_id,
       codex_turn_id, input_fingerprint, frontier_json, submission_kind, started_at
     ) VALUES (
       'attempt-v16', 'logical-v16', 'batch-v16', 'account-v16', 'Accepted',
       'thread-v16', 'turn-v16', 'fingerprint-v16',
       '{"itemIds":[],"turnIds":[]}', 'Start', ?
     )`,
    [CREATED_AT],
  );
  database.run(
    `INSERT INTO scheduler_state(
       singleton, generation_id, active_logical_turn_id, active_codex_turn_id,
       active_acknowledged, generation_broken, timer_deadline_at, updated_at
     ) VALUES (1, 'generation-v16', 'logical-v16', 'turn-v16', 1, 0, ?, ?)`,
    [CREATED_AT, CREATED_AT],
  );
  database.run(
    `INSERT INTO scheduler_pool_messages(inbound_message_id, ordinal)
     VALUES ('pooled-message', 0)`,
  );
};

const seedAccountState = (database: Database): void => {
  database.run(
    `INSERT INTO account_observations(
       account_id, observed_at, usable, mode, usage_json, reset_at, selected_at
     ) VALUES (
       'account-v16', ?, 0, 'Capacity', '{"remaining":0}',
       '2026-07-19T09:00:00.000Z', '2026-07-19T07:59:00.000Z'
     )`,
    [CREATED_AT],
  );
};

const makePopulatedVersionSixteen = (databasePath: string): void => {
  const database = new Database(databasePath, { strict: true });
  try {
    rebuildInboundAsVersionSixteen(database);
    const seed = database.transaction(() => {
      seedConversationState(database);
      seedSchedulerState(database);
      seedAccountState(database);
      database.run('DELETE FROM schema_meta');
      database.run('INSERT INTO schema_meta(version, applied_at) VALUES (?, ?)', [
        SCHEMA_VERSION_SIXTEEN,
        CREATED_AT,
      ]);
    });
    seed();
    expect(database.query<unknown, []>('PRAGMA foreign_key_check').all()).toStrictEqual([]);
  } finally {
    database.close();
  }
};

const assertVersionSixteenFixture = (databasePath: string): void => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    expect(schemaVersion(database)).toBe(SCHEMA_VERSION_SIXTEEN);
    const inboundColumns = databaseNames(database, "PRAGMA table_info('inbound_messages')");
    expect(inboundColumns).toContain('message_guid');
    expect(inboundColumns).not.toContain('source_kind');
    expect(inboundColumns).not.toContain('source_id');
    expect(
      databaseNames(
        database,
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('schedules', 'scheduled_runs', 'schedule_tool_calls')
         ORDER BY name`,
      ),
    ).toStrictEqual([]);
    expect(databaseNames(database, "PRAGMA index_list('attachments')")).toContain(
      'attachments_inbound_message',
    );
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM inbound_messages').get()
        ?.count,
    ).toBe(INBOUND_MESSAGE_COUNT);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM attachments').get()
        ?.count,
    ).toBe(2);
    expect(
      database
        .query<{ mode: string; selected_at: string }, []>(
          "SELECT mode, selected_at FROM account_observations WHERE account_id = 'account-v16'",
        )
        .get(),
    ).toStrictEqual({ mode: 'Capacity', selected_at: '2026-07-19T07:59:00.000Z' });
  } finally {
    database.close();
  }
};

export { assertVersionSixteenFixture, databaseNames, makePopulatedVersionSixteen, schemaVersion };
