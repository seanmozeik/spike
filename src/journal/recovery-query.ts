import { attachmentInputTextSql } from './attachment-input';

const PENDING_INBOUND_QUERY = `SELECT im.id, im.text, im.observed_at,
       MAX(CASE WHEN a.state = 'Observed' THEN 1 ELSE 0 END) AS has_observed_attachment,
       ${attachmentInputTextSql} AS attachment_text
FROM inbound_messages im
LEFT JOIN attachments a ON a.inbound_message_id = im.id
WHERE im.source_kind = 'Messages'
AND im.messages_rowid > ? AND im.messages_rowid <= ?
AND NOT EXISTS (
  SELECT 1 FROM input_batch_messages ibm WHERE ibm.inbound_message_id = im.id
) AND NOT EXISTS (
  SELECT 1 FROM scheduler_pool_messages spm WHERE spm.inbound_message_id = im.id
) AND NOT EXISTS (
  SELECT 1 FROM handled_control_messages hcm WHERE hcm.inbound_message_id = im.id
) AND NOT EXISTS (
  SELECT 1 FROM handled_approval_messages ham WHERE ham.inbound_message_id = im.id
)
GROUP BY im.id, im.text, im.observed_at, im.messages_rowid
ORDER BY im.messages_rowid`;

export { ATTACHMENTS_INBOUND_MESSAGE_INDEX } from './query-indexes';
export { PENDING_INBOUND_QUERY };
