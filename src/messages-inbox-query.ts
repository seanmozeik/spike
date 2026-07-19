const ATTACHMENT_QUERY = `SELECT a.guid AS attachment_guid, a.filename, a.mime_type,
  a.transfer_name, a.uti, a.total_bytes
  FROM attachment a JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
  WHERE maj.message_id = ? ORDER BY a.ROWID ASC`;

const CONFIGURED_ROWS_CTE = `configured_rows AS MATERIALIZED (
  SELECT m.ROWID AS rowid, m.guid AS message_guid, m.text,
    m.attributedBody AS attributed_body, m.cache_has_attachments,
    (m.date / 1000000.0) + 978307200000.0 AS unix_ms,
    m.is_from_me, m.service, h.id AS handle_id, c.guid AS chat_guid,
    EXISTS (
      SELECT 1 FROM message_attachment_join maj
      JOIN attachment a ON a.ROWID = maj.attachment_id
      WHERE maj.message_id = m.ROWID
    ) AS has_materialized_attachment
  FROM chat c
  JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
  JOIN message m ON m.ROWID = cmj.message_id
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID > ?1 AND c.guid = ?2 AND c.style = 45
)`;

const CLASSIFIED_ROWS_CTE = `classified_rows AS (
  SELECT *,
    is_from_me = 0 AND service = 'iMessage' AND lower(handle_id) = lower(?3)
      AS is_target_inbound,
    is_from_me = 0 AND service = 'iMessage' AND lower(handle_id) = lower(?3)
      AND (text IS NOT NULL OR attributed_body IS NOT NULL OR has_materialized_attachment = 1)
      AND (cache_has_attachments <> 1 OR has_materialized_attachment = 1)
      AS is_ready_inbound
  FROM configured_rows
)`;

const FIRST_BLOCKED_ROW_CTE = `first_blocked_row AS (
  SELECT MIN(rowid) AS rowid FROM classified_rows
  WHERE is_target_inbound = 1 AND is_ready_inbound = 0
)`;

const MESSAGE_QUERY = `WITH ${CONFIGURED_ROWS_CTE}, ${CLASSIFIED_ROWS_CTE},
  ${FIRST_BLOCKED_ROW_CTE}
  SELECT rowid, message_guid, text, attributed_body, cache_has_attachments,
    unix_ms, handle_id, chat_guid
  FROM classified_rows
  WHERE is_ready_inbound = 1
    AND rowid < COALESCE((SELECT rowid FROM first_blocked_row), 9223372036854775807)
  ORDER BY rowid ASC`;

const FRONTIER_QUERY = `WITH ${CONFIGURED_ROWS_CTE}, ${CLASSIFIED_ROWS_CTE},
  ${FIRST_BLOCKED_ROW_CTE}
  SELECT COALESCE(MAX(rowid), 0) AS rowid
  FROM classified_rows
  WHERE is_ready_inbound = 1
    AND rowid < COALESCE((SELECT rowid FROM first_blocked_row), 9223372036854775807)`;

const IDLE_FRONTIER_QUERY = `WITH configured_rows AS MATERIALIZED (
    SELECT m.ROWID AS rowid, m.is_from_me
    FROM chat c
    JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    JOIN message m ON m.ROWID = cmj.message_id
    WHERE m.ROWID > ?1 AND c.guid = ?2 AND c.style = 45
  ), first_inbound_row AS (
    SELECT MIN(rowid) AS rowid FROM configured_rows WHERE is_from_me IS NOT 1
  )
  SELECT COALESCE(MAX(rowid), ?1) AS rowid
  FROM configured_rows
  WHERE is_from_me = 1
    AND rowid < COALESCE((SELECT rowid FROM first_inbound_row), 9223372036854775807)`;

export { ATTACHMENT_QUERY, FRONTIER_QUERY, IDLE_FRONTIER_QUERY, MESSAGE_QUERY };
