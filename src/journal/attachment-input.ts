import type { Database } from 'bun:sqlite';

import type { StagedImageAttachment } from '../attachments/model';

interface StagedImageRow {
  readonly content_hash: string;
  readonly mime_type: StagedImageAttachment['mimeType'];
  readonly staged_path: string;
}

const attachmentInputTextSql = `GROUP_CONCAT(
  CASE
    WHEN a.state = 'Failed' AND a.failure_code = 'legacy-claimed' THEN
      '[Attachment: ' || COALESCE(a.filename, a.transfer_name, a.attachment_guid) ||
      CASE WHEN a.mime_type IS NULL THEN '' ELSE ' (' || a.mime_type || ')' END || ']'
    WHEN a.state IN ('Staged', 'Assigned') AND
         a.mime_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp') THEN
      '[Image attachment (' || COALESCE(a.mime_type, 'unknown') || ')]'
    WHEN a.state IN ('Staged', 'Assigned') THEN
      '[Attachment available at ' || a.staged_path ||
      CASE WHEN a.mime_type IS NULL THEN '' ELSE ' (' || a.mime_type || ')' END || ']'
    WHEN a.state = 'Failed' THEN
      '[Attachment rejected: ' || COALESCE(a.failure_code, 'unsupported-type') || ']'
    ELSE NULL
  END
, char(10) ORDER BY a.ordinal, a.id)`;

const renderPersistedInputText = ({
  attachmentText,
  text,
}: {
  readonly attachmentText: string | null;
  readonly text: string | null;
}): string => [text, attachmentText].filter((part): part is string => part !== null).join('\n');

const readStagedImages = (
  database: Database,
  inboundMessageId: string,
): readonly StagedImageAttachment[] =>
  database
    .query<StagedImageRow, [string]>(
      `SELECT content_hash, mime_type, staged_path FROM attachments
       WHERE inbound_message_id = ? AND state IN ('Staged', 'Assigned')
         AND content_hash IS NOT NULL AND staged_path IS NOT NULL
         AND mime_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')
       ORDER BY ordinal, id`,
    )
    .all(inboundMessageId)
    .map((row) => ({
      contentHash: row.content_hash,
      mimeType: row.mime_type,
      path: row.staged_path,
    }));

export { attachmentInputTextSql, readStagedImages, renderPersistedInputText };
