import type { Database } from 'bun:sqlite';

import type { AttachmentStore } from '../attachments/store';

type RedactTransaction = (cutoff: string, redactedAt: string) => number;

const REDACT_INBOUND = `UPDATE inbound_messages
  SET text = NULL, payload_redacted_at = ?
  WHERE payload_redacted_at IS NULL AND observed_at < ? AND (
    id IN (
      SELECT ibm.inbound_message_id FROM input_batch_messages ibm
      JOIN input_batches ib ON ib.id = ibm.input_batch_id
      JOIN logical_turns lt ON lt.id = ib.logical_turn_id
      WHERE lt.state IN ('Completed','Failed','Superseded') AND NOT EXISTS (
        SELECT 1 FROM outbound_messages om WHERE om.logical_turn_id = lt.id
        AND om.state NOT IN ('Delivered','Failed','Superseded')
      )
    )
    OR EXISTS (
      SELECT 1 FROM handled_control_messages hcm WHERE hcm.inbound_message_id = inbound_messages.id
    )
    OR EXISTS (
      SELECT 1 FROM handled_approval_messages ham WHERE ham.inbound_message_id = inbound_messages.id
    )
    OR EXISTS (
      SELECT 1 FROM scheduled_runs sr WHERE sr.inbound_message_id = inbound_messages.id
        AND sr.state IN ('Completed','Failed')
    )
  )`;
const REDACT_ATTACHMENTS = `UPDATE attachments
  SET filename = NULL, transfer_name = NULL, source_path = NULL, staged_path = NULL,
      content_hash = NULL, state = 'Redacted', payload_redacted_at = ?
  WHERE payload_redacted_at IS NULL AND inbound_message_id IN (
    SELECT id FROM inbound_messages WHERE payload_redacted_at IS NOT NULL
  )`;
const REDACT_OUTBOUND_MESSAGES = `UPDATE outbound_messages
  SET text = NULL, payload_redacted_at = ?
  WHERE payload_redacted_at IS NULL AND created_at < ?
    AND state IN ('Delivered','Failed','Superseded')`;
const REDACT_OUTBOUND_CHUNKS = `UPDATE outbound_chunks
  SET text = NULL, payload_redacted_at = ?
  WHERE payload_redacted_at IS NULL AND id IN (
    SELECT oc.id FROM outbound_chunks oc
    JOIN outbound_messages om ON om.id = oc.outbound_message_id
    WHERE om.created_at < ?
      AND om.state IN ('Delivered','Failed','Superseded')
  )`;
const REDACT_CODEX_AGENT_ITEMS = `UPDATE codex_agent_items
  SET payload_json = NULL, payload_redacted_at = ?
  WHERE payload_redacted_at IS NULL AND id IN (
    SELECT cai.id FROM codex_agent_items cai
    JOIN codex_attempts ca ON ca.id = cai.codex_attempt_id
    JOIN logical_turns lt ON lt.id = ca.logical_turn_id
    WHERE cai.observed_at < ?
      AND lt.state IN ('Completed','Failed','Superseded')
      AND (lt.state = 'Superseded' OR ca.state IN ('Completed','Failed'))
      AND NOT EXISTS (
        SELECT 1 FROM outbound_messages om
        WHERE om.logical_turn_id = lt.id
          AND om.state NOT IN ('Delivered','Failed','Superseded')
      )
  )`;
const REDACT_APPROVAL_REQUESTS = `UPDATE approval_requests
  SET params_json = '{}', command_text = NULL, cwd = NULL, file_paths_json = '[]',
      reason = NULL, response_json = NULL, delivery_error = NULL, payload_redacted_at = ?
  WHERE payload_redacted_at IS NULL AND requested_at < ?
    AND state IN ('Approved','Denied','Expired','Cancelled','Orphaned')`;
const REDACT_SCHEDULES = `UPDATE schedules
  SET prompt = NULL, payload_redacted_at = ?, revision = revision + 1
  WHERE payload_redacted_at IS NULL AND updated_at < ?
    AND state IN ('Completed','Cancelled')`;
const REDACT_SCHEDULE_RUNS = `UPDATE scheduled_runs
  SET error = NULL, payload_redacted_at = ?
  WHERE payload_redacted_at IS NULL AND completed_at < ?
    AND state IN ('Completed','Failed')`;
const REDACT_SCHEDULE_TOOL_CALLS = `UPDATE schedule_tool_calls
  SET response_json = NULL, payload_redacted_at = ?
  WHERE payload_redacted_at IS NULL AND created_at < ?`;
const PRUNE_FAILURES = 'DELETE FROM failures WHERE created_at < ?';
const PRUNE_ACCOUNT_OBSERVATIONS = 'DELETE FROM account_observations WHERE observed_at < ?';

const removableStagedPaths = (database: Database): readonly string[] =>
  database
    .query<{ staged_path: string }, []>(
      `SELECT DISTINCT attachment.staged_path FROM attachments attachment
       JOIN inbound_messages inbound ON inbound.id = attachment.inbound_message_id
       WHERE inbound.payload_redacted_at IS NOT NULL AND attachment.staged_path IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM attachments retained
           JOIN inbound_messages retained_inbound
             ON retained_inbound.id = retained.inbound_message_id
           WHERE retained.staged_path = attachment.staged_path
             AND retained_inbound.payload_redacted_at IS NULL
         )`,
    )
    .all()
    .map(({ staged_path }) => staged_path);

const makeRedact = (database: Database, attachmentStore?: AttachmentStore): RedactTransaction =>
  database.transaction((cutoff: string, redactedAt: string): number => {
    const result = database.run(REDACT_INBOUND, [redactedAt, cutoff]);
    for (const stagedPath of removableStagedPaths(database)) {
      if (attachmentStore === undefined) {
        throw new Error('attachment staging store is unavailable during redaction');
      }
      attachmentStore.remove(stagedPath);
    }
    database.run(REDACT_ATTACHMENTS, [redactedAt]);
    database.run(REDACT_OUTBOUND_MESSAGES, [redactedAt, cutoff]);
    database.run(REDACT_OUTBOUND_CHUNKS, [redactedAt, cutoff]);
    database.run(REDACT_CODEX_AGENT_ITEMS, [redactedAt, cutoff]);
    database.run(REDACT_APPROVAL_REQUESTS, [redactedAt, cutoff]);
    database.run(REDACT_SCHEDULES, [redactedAt, cutoff]);
    database.run(REDACT_SCHEDULE_RUNS, [redactedAt, cutoff]);
    database.run(REDACT_SCHEDULE_TOOL_CALLS, [redactedAt, cutoff]);
    database.run(PRUNE_FAILURES, [cutoff]);
    database.run(PRUNE_ACCOUNT_OBSERVATIONS, [cutoff]);
    return result.changes;
  });

export { makeRedact };
