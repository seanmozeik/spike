import type { Database } from 'bun:sqlite';

const reconcileClaimedObservedAttachments = (database: Database): number =>
  database.run(
    `UPDATE attachments AS attachment
     SET state = 'Failed', failure_code = 'legacy-claimed', source_path = NULL
     WHERE state = 'Observed' AND (
       EXISTS (
         SELECT 1 FROM input_batch_messages batch
         WHERE batch.inbound_message_id = attachment.inbound_message_id
       ) OR EXISTS (
         SELECT 1 FROM handled_control_messages control
         WHERE control.inbound_message_id = attachment.inbound_message_id
       ) OR EXISTS (
         SELECT 1 FROM handled_approval_messages approval
         WHERE approval.inbound_message_id = attachment.inbound_message_id
       )
     )`,
  ).changes;

export { reconcileClaimedObservedAttachments };
