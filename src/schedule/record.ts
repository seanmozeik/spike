import type { Database } from 'bun:sqlite';

import { ScheduleId, type ScheduleRecord, type ScheduleStateValue } from './model';

interface ScheduleRow {
  readonly id: string;
  readonly kind: 'OneShot' | 'Recurring';
  readonly last_run_at: null | string;
  readonly name: null | string;
  readonly next_due_at: null | string;
  readonly one_shot_at: string;
  readonly prompt: null | string;
  readonly revision: number;
  readonly rrule: null | string;
  readonly state: ScheduleStateValue;
  readonly timezone: string;
}

const scheduleRecord = (row: ScheduleRow): ScheduleRecord => ({
  id: ScheduleId.make(row.id),
  kind: row.kind,
  name: row.name,
  nextDueAt: row.next_due_at === null ? null : new Date(row.next_due_at),
  oneShotAt: new Date(row.one_shot_at),
  prompt: row.prompt,
  rrule: row.rrule,
  state: row.state,
  timezone: row.timezone,
});

const selectScheduleRow = (database: Database, id: ScheduleId): ScheduleRow => {
  const row = database.query<ScheduleRow, [string]>('SELECT * FROM schedules WHERE id = ?').get(id);
  if (row === null) {
    throw new Error('schedule not found');
  }
  return row;
};

const selectSchedule = (database: Database, id: ScheduleId): ScheduleRecord =>
  scheduleRecord(selectScheduleRow(database, id));

export { scheduleRecord, selectSchedule, selectScheduleRow };
export type { ScheduleRow };
