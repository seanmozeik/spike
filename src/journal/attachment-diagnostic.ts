import { Database } from 'bun:sqlite';

import { makeOutageDiagnostic, type OutageDiagnostic } from './outage-diagnostic';

const ATTACHMENT_STAGING_EPISODE_KIND = 'AttachmentStagingPermissionDenied';
const ATTACHMENT_STAGING_DIAGNOSTIC =
  'Attachment staging blocked: grant Full Disk Access to the Bun executable running Spike; Spike retries every 5m.';

interface AttachmentStagingDiagnostic {
  readonly blockedSince: string;
  readonly diagnostic: string;
}

const makeAttachmentDiagnostic = (database: Database): OutageDiagnostic =>
  makeOutageDiagnostic(database, {
    errorTag: 'AttachmentStagingPermissionError',
    kind: ATTACHMENT_STAGING_EPISODE_KIND,
    message: ATTACHMENT_STAGING_DIAGNOSTIC,
    operation: 'attachment-staging',
  });

const readAttachmentStagingDiagnostic = (
  database: Database,
): AttachmentStagingDiagnostic | null => {
  const row = database
    .query<{ opened_at: string }, [string]>(
      "SELECT opened_at FROM outage_episodes WHERE kind = ? AND state = 'Open'",
    )
    .get(ATTACHMENT_STAGING_EPISODE_KIND);
  return row === null
    ? null
    : { blockedSince: row.opened_at, diagnostic: ATTACHMENT_STAGING_DIAGNOSTIC };
};

const inspectAttachmentStagingDiagnostic = (path: string): AttachmentStagingDiagnostic | null => {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return readAttachmentStagingDiagnostic(database);
  } finally {
    database.close();
  }
};

export {
  ATTACHMENT_STAGING_DIAGNOSTIC,
  ATTACHMENT_STAGING_EPISODE_KIND,
  inspectAttachmentStagingDiagnostic,
  makeAttachmentDiagnostic,
  readAttachmentStagingDiagnostic,
};
export type { AttachmentStagingDiagnostic };
