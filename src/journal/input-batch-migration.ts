import type { Database } from 'bun:sqlite';

import { canonicalInputFingerprint } from '../codex/reconcile';
import { inputBatchText } from '../scheduler/input-batch';
import { renderPersistedInputText } from './attachment-input';

const LEGACY_ATTACHMENT_INPUT_TEXT_SQL = `GROUP_CONCAT(
  '[Attachment: ' || COALESCE(a.filename, a.transfer_name, a.attachment_guid) ||
  CASE WHEN a.mime_type IS NULL THEN '' ELSE ' (' || a.mime_type || ')' END || ']'
, char(10))`;

interface LegacyAttemptRow {
  readonly id: string;
  readonly input_fingerprint: string | null;
  readonly logical_turn_id: string;
  readonly started_at: string;
  readonly submission_kind: 'Start' | 'Steer';
}

interface PersistedBatchRow {
  readonly created_at: string;
  readonly id: string;
  readonly kind: 'Initial' | 'Steer';
  readonly logical_turn_id: string;
  readonly sequence: number;
}

interface BatchMessageRow {
  readonly attachment_text: string | null;
  readonly text: string | null;
}

interface MigratedBatch extends PersistedBatchRow {
  readonly canonicalFingerprint: string;
}

const hasColumn = (database: Database, table: string, column: string): boolean =>
  database
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some(({ name }) => name === column);

const ensureIdentityColumns = (database: Database): void => {
  if (!hasColumn(database, 'input_batches', 'sequence')) {
    database.run('ALTER TABLE input_batches ADD COLUMN sequence INTEGER CHECK(sequence > 0)');
  }
  if (!hasColumn(database, 'codex_attempts', 'input_batch_id')) {
    database.run(
      'ALTER TABLE codex_attempts ADD COLUMN input_batch_id TEXT REFERENCES input_batches(id) ON DELETE RESTRICT',
    );
  }
};

const backfillBatchSequences = (database: Database): void => {
  database.run(
    `UPDATE input_batches AS target
     SET sequence = (
       SELECT COUNT(*)
       FROM input_batches AS prior
       WHERE prior.logical_turn_id = target.logical_turn_id
         AND (
           prior.created_at < target.created_at OR
           (prior.created_at = target.created_at AND prior.rowid <= target.rowid)
         )
     )
     WHERE sequence IS NULL`,
  );
};

const canonicalBatchFingerprint = (database: Database, batchId: string): string => {
  const messages = database
    .query<BatchMessageRow, [string]>(
      `SELECT im.text, ${LEGACY_ATTACHMENT_INPUT_TEXT_SQL} AS attachment_text
       FROM input_batch_messages ibm
       JOIN inbound_messages im ON im.id = ibm.inbound_message_id
       LEFT JOIN attachments a ON a.inbound_message_id = im.id
       WHERE ibm.input_batch_id = ?
       GROUP BY im.id, im.text, ibm.ordinal
       ORDER BY ibm.ordinal`,
    )
    .all(batchId)
    .map((row) => ({
      text: renderPersistedInputText({ attachmentText: row.attachment_text, text: row.text }),
    }));
  return canonicalInputFingerprint(inputBatchText(messages));
};

const loadBatches = (database: Database): readonly MigratedBatch[] =>
  database
    .query<PersistedBatchRow, []>(
      `SELECT id, logical_turn_id, sequence, kind, created_at
       FROM input_batches
       ORDER BY logical_turn_id, sequence`,
    )
    .all()
    .map((batch) => ({
      canonicalFingerprint: canonicalBatchFingerprint(database, batch.id),
      created_at: batch.created_at,
      id: batch.id,
      kind: batch.kind,
      logical_turn_id: batch.logical_turn_id,
      sequence: batch.sequence,
    }));

const migrateAttemptBatchIds = (database: Database, batches: readonly MigratedBatch[]): void => {
  const claimed = new Set(
    database
      .query<{ input_batch_id: string }, []>(
        'SELECT input_batch_id FROM codex_attempts WHERE input_batch_id IS NOT NULL',
      )
      .all()
      .map(({ input_batch_id }) => input_batch_id),
  );
  const attempts = database
    .query<LegacyAttemptRow, []>(
      `SELECT id, logical_turn_id, input_fingerprint, submission_kind, started_at
       FROM codex_attempts
       WHERE input_batch_id IS NULL AND submission_kind IN ('Start','Steer')
       ORDER BY started_at DESC, id DESC`,
    )
    .all();
  for (const attempt of attempts) {
    if (attempt.input_fingerprint !== null) {
      const batchKind = attempt.submission_kind === 'Start' ? 'Initial' : 'Steer';
      const batch = batches.findLast(
        (candidate) =>
          candidate.logical_turn_id === attempt.logical_turn_id &&
          candidate.kind === batchKind &&
          candidate.canonicalFingerprint === attempt.input_fingerprint &&
          candidate.created_at <= attempt.started_at &&
          !claimed.has(candidate.id),
      );
      if (batch !== undefined) {
        database.run('UPDATE codex_attempts SET input_batch_id = ? WHERE id = ?', [
          batch.id,
          attempt.id,
        ]);
        claimed.add(batch.id);
      }
    }
  }
};

const ensureInputBatchIdentityIndexes = (database: Database): void => {
  database.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS input_batches_turn_sequence
     ON input_batches(logical_turn_id, sequence)`,
  );
  database.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS codex_attempts_one_per_input_batch
     ON codex_attempts(input_batch_id) WHERE input_batch_id IS NOT NULL`,
  );
};

const migrateInputBatchIdentity = (database: Database): void => {
  ensureIdentityColumns(database);
  backfillBatchSequences(database);
  migrateAttemptBatchIds(database, loadBatches(database));
  ensureInputBatchIdentityIndexes(database);
};

export { ensureInputBatchIdentityIndexes, migrateInputBatchIdentity };
