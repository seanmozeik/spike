import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import { tryJournalTransaction, type JournalTransactionError } from '../errors';
import { requiredText, trimmedOrNull } from './input-normalization';
import { updateSchedule } from './journal-update';
import {
  ScheduleId,
  ScheduleError,
  type DueSchedule,
  type ScheduleCreateInput,
  type ScheduleRecord,
  type ScheduleUpdateInput,
} from './model';
import { normalizeInitialSchedule } from './normalization';
import { scheduleRecord, selectSchedule, selectScheduleRow, type ScheduleRow } from './record';
import { unfiredDueAt } from './recurrence';

interface ScheduleJournal {
  readonly cancel: (id: ScheduleId, now: Date) => Effect.Effect<ScheduleRecord, ScheduleError>;
  readonly create: (
    input: ScheduleCreateInput,
    now: Date,
  ) => Effect.Effect<ScheduleRecord, ScheduleError>;
  readonly due: (now: Date) => Effect.Effect<DueSchedule | null, JournalTransactionError>;
  readonly list: (
    includeTerminal: boolean,
  ) => Effect.Effect<readonly ScheduleRecord[], ScheduleError>;
  readonly nextDueAt: Effect.Effect<Date | null, JournalTransactionError>;
  readonly pause: (id: ScheduleId, now: Date) => Effect.Effect<ScheduleRecord, ScheduleError>;
  readonly resume: (id: ScheduleId, now: Date) => Effect.Effect<ScheduleRecord, ScheduleError>;
  readonly update: (
    input: ScheduleUpdateInput,
    now: Date,
  ) => Effect.Effect<ScheduleRecord, ScheduleError>;
}

const scheduleError =
  (operation: string) =>
  (cause: unknown): ScheduleError =>
    new ScheduleError({
      cause,
      message: cause instanceof Error ? cause.message : String(cause),
      operation,
    });

const makeCreate =
  (database: Database): ScheduleJournal['create'] =>
  (input, now) =>
    Effect.try({
      catch: scheduleError('create'),
      try: () => {
        const requestedRecurrence = trimmedOrNull(input.rrule);
        const prompt = requiredText(input.prompt, 'prompt must not be empty');
        const { dueAt, recurrence, startsAt } = normalizeInitialSchedule(
          input.oneShotAt,
          requestedRecurrence,
          input.timezone,
          now,
        );
        const id = ScheduleId.make(randomUUID());
        database.run(
          `INSERT INTO schedules(
           id, name, prompt, kind, one_shot_at, rrule, timezone, state,
           next_due_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
          [
            id,
            trimmedOrNull(input.name),
            prompt,
            recurrence === null ? 'OneShot' : 'Recurring',
            startsAt.toISOString(),
            recurrence,
            input.timezone,
            dueAt.toISOString(),
            now.toISOString(),
            now.toISOString(),
          ],
        );
        return selectSchedule(database, id);
      },
    });

const makeList =
  (database: Database): ScheduleJournal['list'] =>
  (includeTerminal) =>
    Effect.try({
      catch: scheduleError('list'),
      try: () =>
        database
          .query<ScheduleRow, []>(
            `SELECT * FROM schedules
           ${includeTerminal ? '' : "WHERE state NOT IN ('Completed','Cancelled')"}
           ORDER BY COALESCE(next_due_at, updated_at), created_at`,
          )
          .all()
          .map((row) => scheduleRecord(row)),
    });

const makeStateChange =
  (
    database: Database,
    target: 'Cancelled' | 'Paused',
  ): ((id: ScheduleId, now: Date) => Effect.Effect<ScheduleRecord, ScheduleError>) =>
  (id, now) =>
    Effect.try({
      catch: scheduleError(target.toLowerCase()),
      try: () => {
        const result = database.run(
          `UPDATE schedules SET state = ?, next_due_at = NULL, updated_at = ?,
             revision = revision + 1
           WHERE id = ? AND state IN ('Active','Paused')`,
          [target, now.toISOString(), id],
        );
        if (result.changes !== 1) {
          throw new Error(`schedule cannot be ${target.toLowerCase()} from its current state`);
        }
        return selectSchedule(database, id);
      },
    });

const makeResume =
  (database: Database): ScheduleJournal['resume'] =>
  (id, now) =>
    Effect.try({
      catch: scheduleError('resume'),
      try: () => {
        const row = selectScheduleRow(database, id);
        const record = scheduleRecord(row);
        if (record.state !== 'Paused' || record.prompt === null) {
          throw new Error('only a retained paused schedule can be resumed');
        }
        const dueAt = unfiredDueAt(
          record.rrule,
          record.oneShotAt,
          record.timezone,
          now,
          row.last_run_at === null ? null : new Date(row.last_run_at),
        );
        if (dueAt === null) {
          throw new Error('schedule has no remaining occurrence');
        }
        const result = database.run(
          `UPDATE schedules SET state = 'Active', next_due_at = ?, updated_at = ?,
           revision = revision + 1 WHERE id = ? AND state = 'Paused'`,
          [dueAt.toISOString(), now.toISOString(), id],
        );
        if (result.changes !== 1) {
          throw new Error('schedule resume lost a concurrent state change');
        }
        return selectSchedule(database, id);
      },
    });

const makeUpdate =
  (database: Database): ScheduleJournal['update'] =>
  (input, now) =>
    Effect.try({ catch: scheduleError('update'), try: () => updateSchedule(database, input, now) });

const makeDue =
  (database: Database): ScheduleJournal['due'] =>
  (now) =>
    tryJournalTransaction('scheduleDue', 'failed to read due schedules', () => {
      const row = database
        .query<ScheduleRow, [string]>(
          "SELECT * FROM schedules WHERE state = 'Active' AND next_due_at <= ? ORDER BY next_due_at, created_at LIMIT 1",
        )
        .get(now.toISOString());
      if (row === null) {
        return null;
      }
      const { next_due_at: nextDueAt, prompt } = row;
      if (prompt === null || nextDueAt === null) {
        return null;
      }
      return {
        expectedDueAt: new Date(nextDueAt),
        expectedRevision: row.revision,
        id: ScheduleId.make(row.id),
        kind: row.kind,
        oneShotAt: new Date(row.one_shot_at),
        prompt,
        rrule: row.rrule,
        timezone: row.timezone,
      };
    });

const makeNextDue = (database: Database): ScheduleJournal['nextDueAt'] =>
  tryJournalTransaction('scheduleNextDue', 'failed to read next schedule deadline', () => {
    const value = database
      .query<{ next_due_at: null | string }, []>(
        "SELECT MIN(next_due_at) AS next_due_at FROM schedules WHERE state = 'Active'",
      )
      .get()?.next_due_at;
    return value === null || value === undefined ? null : new Date(value);
  });

const makeScheduleJournal = (database: Database): ScheduleJournal => ({
  cancel: makeStateChange(database, 'Cancelled'),
  create: makeCreate(database),
  due: makeDue(database),
  list: makeList(database),
  nextDueAt: makeNextDue(database),
  pause: makeStateChange(database, 'Paused'),
  resume: makeResume(database),
  update: makeUpdate(database),
});

export { makeScheduleJournal };
export type { ScheduleJournal };
