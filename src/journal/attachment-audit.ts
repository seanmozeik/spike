import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import { SafeStagingError } from '../attachments/errors';
import type { AttachmentAuditReference, AttachmentStore } from '../attachments/store';
import { JournalTransactionError } from '../errors';

interface AttachmentReferenceRow {
  readonly content_hash: null | string;
  readonly id: string;
  readonly staged_path: null | string;
  readonly state: 'Assigned' | 'Staged';
  readonly total_bytes: null | number;
}

const auditReference = (row: AttachmentReferenceRow): AttachmentAuditReference | null =>
  row.content_hash === null || row.staged_path === null || row.total_bytes === null
    ? null
    : { contentHash: row.content_hash, path: row.staged_path, totalBytes: row.total_bytes };

const failIntegrityAudit = (database: Database, row: AttachmentReferenceRow): void => {
  const updated = database.run(
    `UPDATE attachments SET state = 'Failed', failure_code = 'staged-integrity',
       staged_path = NULL, content_hash = NULL, total_bytes = NULL, mime_type = NULL,
       filename = NULL, source_path = NULL
     WHERE id = ? AND state = ? AND staged_path IS ? AND content_hash IS ?`,
    [row.id, row.state, row.staged_path, row.content_hash],
  );
  if (updated.changes !== 1) {
    throw new SafeStagingError('attachment changed during integrity audit');
  }
};

const auditStagedAttachmentReferences = (database: Database, store: AttachmentStore): number =>
  database.transaction((): number => {
    const rows = database
      .query<AttachmentReferenceRow, []>(
        `SELECT id, state, staged_path, content_hash, total_bytes
         FROM attachments WHERE state IN ('Staged', 'Assigned') ORDER BY id`,
      )
      .all();
    let failed = 0;
    for (const row of rows) {
      const reference = auditReference(row);
      if (reference === null || !store.audit(reference)) {
        failIntegrityAudit(database, row);
        failed += 1;
      }
    }
    return failed;
  })();

const makeAuditStagedAttachments = (
  database: Database,
  store: AttachmentStore,
): Effect.Effect<number, JournalTransactionError> =>
  Effect.try({
    catch: (cause) =>
      new JournalTransactionError({
        cause:
          cause instanceof SafeStagingError
            ? cause
            : new SafeStagingError('unexpected attachment integrity audit failure'),
        message: 'failed to audit staged attachment integrity',
        transaction: 'auditStagedAttachments',
      }),
    try: () => auditStagedAttachmentReferences(database, store),
  });

export { auditStagedAttachmentReferences, makeAuditStagedAttachments };
