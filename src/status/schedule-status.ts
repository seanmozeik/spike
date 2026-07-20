import type { Database } from 'bun:sqlite';

import type { StatusSnapshot } from './model';

interface ScheduleStatusRow {
  readonly active: number;
  readonly cancelled: number;
  readonly completed: number;
  readonly next_due_at: null | string;
  readonly paused: number;
  readonly queued: number;
  readonly running: number;
}

const readScheduleStatus = (database: Database): NonNullable<StatusSnapshot['schedules']> => {
  const row = database
    .query<ScheduleStatusRow, []>(
      `SELECT
         COALESCE(SUM(CASE WHEN state = 'Active' THEN 1 ELSE 0 END), 0) AS active,
         COALESCE(SUM(CASE WHEN state = 'Paused' THEN 1 ELSE 0 END), 0) AS paused,
         COALESCE(SUM(CASE WHEN state = 'Completed' THEN 1 ELSE 0 END), 0) AS completed,
         COALESCE(SUM(CASE WHEN state = 'Cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
         MIN(CASE WHEN state = 'Active' THEN next_due_at END) AS next_due_at,
         (SELECT COUNT(*) FROM scheduled_runs WHERE state = 'Enqueued') AS queued,
         (SELECT COUNT(*) FROM scheduled_runs WHERE state = 'Running') AS running
       FROM schedules`,
    )
    .get();
  return {
    active: row?.active ?? 0,
    cancelled: row?.cancelled ?? 0,
    completed: row?.completed ?? 0,
    nextDueAt: row?.next_due_at ?? null,
    paused: row?.paused ?? 0,
    queued: row?.queued ?? 0,
    running: row?.running ?? 0,
  };
};

export { readScheduleStatus };
