import type { Database } from 'bun:sqlite';

import type { LogicalTurnId } from '../domain/ids';
import type { SchedulerAction } from '../scheduler/model';

const claimSchedule = (
  database: Database,
  action: Extract<SchedulerAction, { readonly kind: 'ClaimSchedule' }>,
  claimedAt: string,
): void => {
  const updated = database.run(
    `UPDATE schedules SET state = ?, next_due_at = ?, last_run_at = ?, updated_at = ?,
       revision = revision + 1
     WHERE id = ? AND state = 'Active' AND next_due_at = ? AND revision = ?`,
    [
      action.nextDueAt === null ? 'Completed' : 'Active',
      action.nextDueAt?.toISOString() ?? null,
      action.scheduledFor.toISOString(),
      claimedAt,
      action.scheduleId,
      action.expectedDueAt.toISOString(),
      action.expectedRevision,
    ],
  );
  if (updated.changes !== 1) {
    throw new Error('schedule due claim lost its active occurrence');
  }
  database.run(
    `INSERT INTO inbound_messages(
       id, source_kind, source_id, message_guid, messages_rowid, chat_guid, handle,
       service, text, sent_at, observed_at
     ) VALUES (?, 'ScheduleRun', ?, NULL, NULL, '', '', 'Schedule', ?, ?, ?)`,
    [
      action.message.id,
      action.runId,
      action.message.text,
      action.scheduledFor.toISOString(),
      claimedAt,
    ],
  );
  database.run(
    `INSERT INTO scheduled_runs(
       id, schedule_id, scheduled_for, state, inbound_message_id, enqueued_at
     ) VALUES (?, ?, ?, 'Enqueued', ?, ?)`,
    [
      action.runId,
      action.scheduleId,
      action.scheduledFor.toISOString(),
      action.message.id,
      claimedAt,
    ],
  );
};

const markScheduleRunStarted = (
  database: Database,
  inboundId: string,
  logicalTurnId: LogicalTurnId,
  startedAt: string,
): void => {
  database.run(
    `UPDATE scheduled_runs SET state = 'Running', logical_turn_id = ?, started_at = ?
     WHERE inbound_message_id = ? AND state = 'Enqueued'`,
    [logicalTurnId, startedAt, inboundId],
  );
};

const finishScheduledRuns = (
  database: Database,
  logicalTurnId: LogicalTurnId,
  state: 'Completed' | 'Failed',
  completedAt: string,
): void => {
  database.run(
    `UPDATE scheduled_runs SET state = ?, completed_at = ?, error = ?
     WHERE logical_turn_id = ? AND state = 'Running'`,
    [state, completedAt, state === 'Failed' ? 'scheduled turn failed' : null, logicalTurnId],
  );
};

const failGenerationScheduledRuns = (
  database: Database,
  generationId: string,
  failedAt: string,
): void => {
  database.run(
    `UPDATE scheduled_runs SET state = 'Failed', completed_at = ?, error = 'generation reset'
     WHERE state = 'Running' AND logical_turn_id IN (
       SELECT id FROM logical_turns WHERE generation_id = ?
     )`,
    [failedAt, generationId],
  );
  database.run(
    `UPDATE scheduled_runs SET state = 'Failed', completed_at = ?, error = 'generation reset'
     WHERE state = 'Enqueued' AND inbound_message_id IN (
       SELECT inbound_message_id FROM scheduler_pool_messages
     )`,
    [failedAt],
  );
};

export { claimSchedule, failGenerationScheduledRuns, finishScheduledRuns, markScheduleRunStarted };
