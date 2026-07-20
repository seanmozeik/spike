import type { Database } from 'bun:sqlite';

import { failGenerationScheduledRuns } from '../schedule/scheduler-persistence';
import type { SchedulerAction, SchedulerState } from '../scheduler/model';
import { resetCurrentGeneration } from './scheduler-generation';

type ResetAction = Extract<SchedulerAction, { readonly kind: 'ResetGeneration' }>;

const assertResetOwnership = (
  database: Database,
  state: SchedulerState,
  action: ResetAction,
): string => {
  const current = database
    .query<{ id: string }, []>("SELECT id FROM generations WHERE state = 'Current'")
    .get();
  if (
    current === null ||
    current.id !== action.oldGenerationId ||
    state.generationId !== action.newGenerationId
  ) {
    throw new Error('reset generation ownership does not match the scheduler transition');
  }
  return current.id;
};

const supersedeGenerationWork = (
  database: Database,
  generationId: string,
  resetAt: string,
): void => {
  database.run(
    `UPDATE codex_attempts SET state = 'Failed', finished_at = COALESCE(finished_at, ?)
     WHERE logical_turn_id IN (
       SELECT id FROM logical_turns WHERE generation_id = ?
     ) AND state IN ('Prepared','Submitted','SubmissionUnknown','Accepted')`,
    [resetAt, generationId],
  );
  database.run(
    `UPDATE logical_turns SET state = 'Superseded', completed_at = COALESCE(completed_at, ?)
     WHERE generation_id = ? AND state NOT IN ('Completed','Failed','Superseded')`,
    [resetAt, generationId],
  );
  database.run(
    `UPDATE outbound_messages SET state = 'Superseded'
     WHERE logical_turn_id IN (SELECT id FROM logical_turns WHERE generation_id = ?)
       AND state IN ('Prepared','Delivering')`,
    [generationId],
  );
};

const orphanGenerationApprovals = (
  database: Database,
  generationId: string,
  resetAt: string,
): void => {
  database.run(
    `UPDATE approval_requests SET state = 'Orphaned', resolved_at = ?,
       delivery_error = COALESCE(delivery_error, 'generation reset')
     WHERE state = 'Pending' AND (
       logical_turn_id IN (SELECT id FROM logical_turns WHERE generation_id = ?)
       OR thread_id = (SELECT codex_thread_id FROM generations WHERE id = ?)
     )`,
    [resetAt, generationId, generationId],
  );
};

const consumeResetCommand = (database: Database, action: ResetAction, resetAt: string): void => {
  database.run(
    `INSERT OR IGNORE INTO handled_control_messages(inbound_message_id, command, handled_at)
     VALUES (?, '/new', ?)`,
    [action.commandMessageId, resetAt],
  );
};

const resetGeneration = (
  database: Database,
  state: SchedulerState,
  action: ResetAction,
  resetAt: string,
): void => {
  const currentGenerationId = assertResetOwnership(database, state, action);
  supersedeGenerationWork(database, currentGenerationId, resetAt);
  orphanGenerationApprovals(database, currentGenerationId, resetAt);
  failGenerationScheduledRuns(database, currentGenerationId, resetAt);
  resetCurrentGeneration(database, action.oldGenerationId, action.newGenerationId, resetAt);
  consumeResetCommand(database, action, resetAt);
};

export { resetGeneration };
