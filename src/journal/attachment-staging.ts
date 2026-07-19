import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import {
  AttachmentStagingPermissionError,
  isFilePermissionDenied,
  SafeStagingError,
} from '../attachments/errors';
import type { AttachmentFailureCode } from '../attachments/model';
import { stageAttachmentFile, type StageResult } from '../attachments/staging';
import type { AttachmentStore } from '../attachments/store';
import { JournalTransactionError } from '../errors';
import { auditStagedAttachmentReferences } from './attachment-audit';
import { reconcileClaimedObservedAttachments } from './attachment-reconciliation';

interface AttachmentStagingOptions {
  readonly afterCopy?: (attachmentId: string) => void;
  readonly afterSourceStat?: (sourcePath: string) => void;
  readonly beforeSourceOpen?: (sourcePath: string) => void;
  readonly maxBytes?: number;
  readonly sourceRoot: string;
  readonly stagingRoot: string;
}

type AttachmentStagingRunOptions = Omit<AttachmentStagingOptions, 'stagingRoot'>;

interface ObservedAttachmentRow {
  readonly id: string;
  readonly source_path: string | null;
}

const markRejected = (
  database: Database,
  attachmentId: string,
  code: AttachmentFailureCode,
): void => {
  database.run(
    `UPDATE attachments SET state = 'Failed', failure_code = ?, filename = NULL,
       source_path = NULL WHERE id = ? AND state = 'Observed'`,
    [code, attachmentId],
  );
};

const referencedStagedPaths = (database: Database): readonly string[] =>
  database
    .query<{ staged_path: string }, []>(
      'SELECT DISTINCT staged_path FROM attachments WHERE staged_path IS NOT NULL',
    )
    .all()
    .map(({ staged_path }) => staged_path);

const markStaged = (
  database: Database,
  attachmentId: string,
  result: Extract<StageResult, { readonly kind: 'Staged' }>,
): void => {
  const updated = database.run(
    `UPDATE attachments SET state = 'Staged', staged_path = ?, content_hash = ?,
       mime_type = ?, total_bytes = ?, failure_code = NULL, filename = NULL, source_path = NULL
     WHERE id = ? AND state = 'Observed'`,
    [result.path, result.contentHash, result.mimeType, result.totalBytes, attachmentId],
  );
  if (updated.changes !== 1) {
    throw new SafeStagingError('attachment state changed during staging');
  }
};

const transitionAttachment = (
  database: Database,
  options: AttachmentStagingRunOptions,
  store: AttachmentStore,
  attachment: ObservedAttachmentRow,
): boolean => {
  const result =
    attachment.source_path === null
      ? ({ code: 'missing-source', kind: 'Rejected' } as const)
      : stageAttachmentFile(attachment.source_path, {
          ...(options.afterSourceStat === undefined
            ? {}
            : { afterSourceStat: options.afterSourceStat }),
          ...(options.beforeSourceOpen === undefined
            ? {}
            : { beforeSourceOpen: options.beforeSourceOpen }),
          ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
          sourceRoot: options.sourceRoot,
          store,
        });
  if (result.kind === 'Retry') {
    return false;
  }
  if (result.kind === 'Rejected') {
    markRejected(database, attachment.id, result.code);
    return true;
  }
  options.afterCopy?.(attachment.id);
  markStaged(database, attachment.id, result);
  return true;
};

const stagingFailure = (
  cause: unknown,
): AttachmentStagingPermissionError | JournalTransactionError => {
  if (cause instanceof AttachmentStagingPermissionError) {
    return cause;
  }
  if (isFilePermissionDenied(cause)) {
    return new AttachmentStagingPermissionError({
      message:
        'Spike cannot write attachment staging. Grant Full Disk Access to the Bun executable that runs spike.',
    });
  }
  return new JournalTransactionError({
    cause:
      cause instanceof SafeStagingError
        ? cause
        : new SafeStagingError('unexpected attachment staging failure'),
    message: 'failed to stage an inbound attachment',
    transaction: 'stagePendingAttachments',
  });
};

const makeStagePendingAttachments = (
  database: Database,
  options: AttachmentStagingRunOptions,
  store: AttachmentStore,
): Effect.Effect<number, AttachmentStagingPermissionError | JournalTransactionError> =>
  Effect.try({
    catch: stagingFailure,
    try: () => {
      let transitioned = auditStagedAttachmentReferences(database, store);
      transitioned += reconcileClaimedObservedAttachments(database);
      const observed = database
        .query<ObservedAttachmentRow, []>(
          `SELECT attachment.id, attachment.source_path
               FROM attachments attachment
               JOIN inbound_messages inbound ON inbound.id = attachment.inbound_message_id
               WHERE attachment.state = 'Observed' AND inbound.payload_redacted_at IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM input_batch_messages batch
                   WHERE batch.inbound_message_id = attachment.inbound_message_id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM handled_control_messages control
                   WHERE control.inbound_message_id = attachment.inbound_message_id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM handled_approval_messages approval
                   WHERE approval.inbound_message_id = attachment.inbound_message_id
                 )
               ORDER BY attachment.created_at, attachment.ordinal, attachment.id`,
        )
        .all();
      for (const attachment of observed) {
        if (transitionAttachment(database, options, store, attachment)) {
          transitioned += 1;
        }
      }
      store.sweep(referencedStagedPaths(database));
      return transitioned;
    },
  });

export { makeStagePendingAttachments };
export type { AttachmentStagingOptions };
