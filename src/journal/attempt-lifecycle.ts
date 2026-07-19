import type { Database } from 'bun:sqlite';

import type { LogicalTurnId } from '../domain/ids';

type LogicalTurnOutcome = 'Completed' | 'Failed';

const finishLogicalTurnAttempts = (
  database: Database,
  logicalTurnId: LogicalTurnId,
  outcome: LogicalTurnOutcome,
  finishedAt: string,
): void => {
  database.run(
    `UPDATE codex_attempts
     SET state = CASE WHEN state = 'Accepted' THEN ? ELSE 'Failed' END,
         finished_at = ?
     WHERE logical_turn_id = ?
       AND state IN ('Prepared','Submitted','SubmissionUnknown','Accepted')`,
    [outcome, finishedAt, logicalTurnId],
  );
};

const repairTerminalTurnAttempts = (database: Database): void => {
  database.run(
    `UPDATE codex_attempts
     SET state = CASE
           WHEN state = 'Accepted' AND (
             SELECT state FROM logical_turns
             WHERE logical_turns.id = codex_attempts.logical_turn_id
           ) = 'Completed' THEN 'Completed'
           ELSE 'Failed'
         END,
         finished_at = COALESCE(
           finished_at,
           (
             SELECT completed_at FROM logical_turns
             WHERE logical_turns.id = codex_attempts.logical_turn_id
           ),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )
     WHERE state IN ('Prepared','Submitted','SubmissionUnknown','Accepted')
       AND logical_turn_id IN (
         SELECT id FROM logical_turns WHERE state IN ('Completed','Failed','Superseded')
       )`,
  );
};

export { finishLogicalTurnAttempts, repairTerminalTurnAttempts };
