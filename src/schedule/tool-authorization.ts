import type { Database } from 'bun:sqlite';

import type { ScheduleToolCall } from './model';

interface ActiveConversationRow {
  readonly active_logical_turn_id: null | string;
  readonly codex_thread_id: null | string;
}

const inactiveConversation = 'schedule tools are unavailable for this inactive conversation';

type ToolAuthorization =
  | { readonly kind: 'Authorized' }
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Rejected'; readonly message: string };

const authorizeScheduleToolCall = (
  database: Database,
  call: ScheduleToolCall,
): ToolAuthorization => {
  const active = database
    .query<ActiveConversationRow, []>(
      `SELECT s.active_logical_turn_id, g.codex_thread_id
       FROM scheduler_state s
       JOIN generations g ON g.id = s.generation_id
       WHERE s.singleton = 1 AND g.state = 'Current'`,
    )
    .get();
  if (active?.active_logical_turn_id === null || active?.codex_thread_id !== call.threadId) {
    return { kind: 'Rejected', message: inactiveConversation };
  }
  const accepted = database
    .query<{ readonly accepted: number }, [string, string, string]>(
      `SELECT 1 AS accepted FROM codex_attempts
       WHERE logical_turn_id = ? AND codex_thread_id = ? AND codex_turn_id = ?
         AND state = 'Accepted'
       LIMIT 1`,
    )
    .get(active.active_logical_turn_id, call.threadId, call.turnId);
  if (accepted !== null) {
    return { kind: 'Authorized' };
  }
  const pending = database
    .query<{ readonly pending: number }, [string, string]>(
      `SELECT 1 AS pending FROM codex_attempts
       WHERE logical_turn_id = ? AND codex_thread_id = ?
         AND submission_kind = 'Start'
         AND state IN ('Prepared','Submitted','SubmissionUnknown')
       LIMIT 1`,
    )
    .get(active.active_logical_turn_id, call.threadId);
  return pending === null
    ? { kind: 'Rejected', message: inactiveConversation }
    : { kind: 'Pending' };
};

export { authorizeScheduleToolCall };
export type { ToolAuthorization };
