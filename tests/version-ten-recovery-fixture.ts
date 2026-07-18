import { Database } from 'bun:sqlite';

import { canonicalInputFingerprint } from '../src/codex/reconcile';

const downgradeIdentitySchema = (database: Database): void => {
  database.run('DROP INDEX codex_attempts_one_per_input_batch');
  database.run('DROP INDEX input_batches_turn_sequence');
  database.run('ALTER TABLE codex_attempts DROP COLUMN input_batch_id');
  database.run('ALTER TABLE input_batches DROP COLUMN sequence');
  database.run('ALTER TABLE approval_requests DROP COLUMN payload_redacted_at');
};

const markVersionTen = (database: Database): void => {
  database.run('DELETE FROM schema_meta');
  database.run(
    "INSERT INTO schema_meta(version, applied_at) VALUES (10, '2026-07-14T12:00:00.000Z')",
  );
};

const seedGenerationAndTurn = (database: Database, createdAt: string): void => {
  database.run(
    `INSERT INTO generations(id, sequence, state, created_at, codex_thread_id)
     VALUES ('generation-legacy', 1, 'Current', ?, 'thread-legacy')`,
    [createdAt],
  );
  database.run(
    `INSERT INTO logical_turns(
       id, generation_id, sequence, state, correlation_id, created_at
     ) VALUES ('logical-legacy', 'generation-legacy', 1, 'Running', 'correlation', ?)`,
    [createdAt],
  );
};

const seedInbound = (
  database: Database,
  suffix: string,
  rowId: number,
  text: string,
  createdAt: string,
): void => {
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (
       ?, ?, ?, 'any;-;+15555550199', '+15555550199', 'iMessage', ?, ?, ?
     )`,
    [`inbound-${suffix}`, `message-${suffix}`, rowId, text, createdAt, createdAt],
  );
};

const seedBatch = (
  database: Database,
  suffix: string,
  kind: 'Initial' | 'Steer',
  createdAt: string,
): void => {
  database.run(
    `INSERT INTO input_batches(id, logical_turn_id, kind, fingerprint, created_at)
     VALUES (?, 'logical-legacy', ?, ?, ?)`,
    [`batch-${suffix}`, kind, `inbound-${suffix}`, createdAt],
  );
  database.run(
    `INSERT INTO input_batch_messages(input_batch_id, inbound_message_id, ordinal)
     VALUES (?, ?, 0)`,
    [`batch-${suffix}`, `inbound-${suffix}`],
  );
};

const seedSchedulerState = (database: Database, createdAt: string): void => {
  database.run(
    `INSERT INTO scheduler_state(
       singleton, generation_id, active_logical_turn_id, active_codex_turn_id,
       active_acknowledged, generation_broken, timer_deadline_at, updated_at
     ) VALUES (1, 'generation-legacy', 'logical-legacy', 'turn-legacy', 0, 0, NULL, ?)`,
    [createdAt],
  );
};

const withVersionTenDatabase = (databasePath: string, seed: (database: Database) => void): void => {
  const database = new Database(databasePath, { strict: true });
  try {
    downgradeIdentitySchema(database);
    seed(database);
    markVersionTen(database);
  } finally {
    database.close();
  }
};

const seedVersionTenActiveAttempt = (databasePath: string): void => {
  withVersionTenDatabase(databasePath, (database) => {
    const createdAt = '2026-07-14T11:59:00.000Z';
    seedGenerationAndTurn(database, createdAt);
    seedInbound(database, 'legacy', 1, 'legacy request', createdAt);
    seedBatch(database, 'legacy', 'Initial', createdAt);
    database.run(
      `INSERT INTO codex_attempts(
         id, logical_turn_id, account_id, state, codex_thread_id, codex_turn_id,
         input_fingerprint, frontier_json, submission_kind, started_at
       ) VALUES (
         'attempt-legacy', 'logical-legacy', 'test-account', 'Accepted', 'thread-legacy',
         'turn-legacy', ?, '{"itemIds":[],"turnIds":[]}', 'Start', ?
       )`,
      [canonicalInputFingerprint('legacy request'), createdAt],
    );
    seedSchedulerState(database, createdAt);
  });
};

const seedVersionTenSteerBacklog = (databasePath: string): void => {
  withVersionTenDatabase(databasePath, (database) => {
    const turnCreatedAt = '2026-07-14T11:58:00.000Z';
    const firstBatchAt = '2026-07-14T11:59:00.000Z';
    const attemptAt = '2026-07-14T11:59:30.000Z';
    const secondBatchAt = '2026-07-14T12:00:00.000Z';
    seedGenerationAndTurn(database, turnCreatedAt);
    seedInbound(database, 'steer-one', 1, 'same steer', firstBatchAt);
    seedBatch(database, 'steer-one', 'Steer', firstBatchAt);
    seedInbound(database, 'steer-two', 2, 'same steer', secondBatchAt);
    seedBatch(database, 'steer-two', 'Steer', secondBatchAt);
    database.run(
      `INSERT INTO codex_attempts(
         id, logical_turn_id, account_id, state, input_fingerprint, frontier_json,
         submission_kind, started_at
       ) VALUES (
         'attempt-steer-one', 'logical-legacy', 'test-account', 'Prepared', ?,
         '{"itemIds":[],"turnIds":["turn-legacy"]}', 'Steer', ?
       )`,
      [canonicalInputFingerprint('same steer'), attemptAt],
    );
    seedSchedulerState(database, turnCreatedAt);
  });
};

export { seedVersionTenActiveAttempt, seedVersionTenSteerBacklog };
