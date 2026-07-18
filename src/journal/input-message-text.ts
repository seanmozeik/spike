interface PersistedInputTextParts {
  readonly attachmentText: string | null;
  readonly text: string | null;
}

const attachmentInputTextSql = `GROUP_CONCAT(
  '[Attachment: ' || COALESCE(a.filename, a.transfer_name, a.attachment_guid) ||
  CASE WHEN a.mime_type IS NULL THEN '' ELSE ' (' || a.mime_type || ')' END || ']'
, char(10))`;

const renderPersistedInputText = ({ attachmentText, text }: PersistedInputTextParts): string =>
  [text, attachmentText].filter((part): part is string => part !== null).join('\n');

export { attachmentInputTextSql, renderPersistedInputText };
