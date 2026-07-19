import type { Database } from 'bun:sqlite';

import { requiredText, trimmedOrNull } from './input-normalization';
import type { ScheduleRecord, ScheduleUpdateInput } from './model';
import { normalizeUnfiredSchedule } from './normalization';
import { scheduleRecord, selectSchedule, selectScheduleRow, type ScheduleRow } from './record';

interface ResolvedCadence {
  readonly nextDueAt: Date | null;
  readonly recurrence: string | null;
  readonly startsAt: Date;
  readonly timezone: string;
}

interface ResolvedUpdate extends ResolvedCadence {
  readonly name: string | null;
  readonly prompt: string;
}

const assertUpdateRequested = (input: ScheduleUpdateInput): void => {
  const requested = [input.name, input.oneShotAt, input.prompt, input.rrule, input.timezone].some(
    (value) => value !== undefined,
  );
  if (!requested) {
    throw new Error('update must change at least one schedule field');
  }
};

const resolveName = (input: ScheduleUpdateInput, current: ScheduleRecord): string | null => {
  if (input.name === undefined) {
    return current.name;
  }
  if (input.name === null) {
    return null;
  }
  return requiredText(input.name, 'name must not be empty; use null to clear it');
};

const cadenceChanged = (input: ScheduleUpdateInput): boolean =>
  input.oneShotAt !== undefined || input.rrule !== undefined || input.timezone !== undefined;

const retainedCadence = (current: ScheduleRecord): ResolvedCadence => ({
  nextDueAt: current.nextDueAt,
  recurrence: current.rrule,
  startsAt: current.oneShotAt,
  timezone: current.timezone,
});

const resolveCadence = (
  input: ScheduleUpdateInput,
  current: ScheduleRecord,
  currentRow: ScheduleRow,
  now: Date,
): ResolvedCadence => {
  if (!cadenceChanged(input)) {
    return retainedCadence(current);
  }
  const { oneShotAt: updatedStart, rrule: updatedRule, timezone: updatedTimezone } = input;
  const oneShotAt = updatedStart ?? current.oneShotAt.toISOString();
  const recurrence = updatedRule === undefined ? current.rrule : trimmedOrNull(updatedRule);
  const timezone = updatedTimezone ?? current.timezone;
  const lastRunAt = currentRow.last_run_at === null ? null : new Date(currentRow.last_run_at);
  const normalized = normalizeUnfiredSchedule(oneShotAt, recurrence, timezone, now, lastRunAt);
  return {
    nextDueAt: current.state === 'Active' ? normalized.dueAt : null,
    recurrence: normalized.recurrence,
    startsAt: normalized.startsAt,
    timezone,
  };
};

const resolveUpdate = (
  input: ScheduleUpdateInput,
  current: ScheduleRecord,
  currentRow: ScheduleRow,
  now: Date,
): ResolvedUpdate => {
  const currentPrompt = current.prompt;
  if (current.state === 'Cancelled' || current.state === 'Completed' || currentPrompt === null) {
    throw new Error('terminal schedules cannot be updated');
  }
  assertUpdateRequested(input);
  const prompt =
    input.prompt === undefined
      ? currentPrompt
      : requiredText(input.prompt, 'prompt must not be empty');
  return {
    ...resolveCadence(input, current, currentRow, now),
    name: resolveName(input, current),
    prompt,
  };
};

const persistUpdate = (
  database: Database,
  input: ScheduleUpdateInput,
  current: ScheduleRecord,
  currentRow: ScheduleRow,
  update: ResolvedUpdate,
  now: Date,
): void => {
  const result = database.run(
    `UPDATE schedules SET name = ?, prompt = ?, kind = ?, one_shot_at = ?, rrule = ?,
       timezone = ?, next_due_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND state = ? AND revision = ?`,
    [
      update.name,
      update.prompt,
      update.recurrence === null ? 'OneShot' : 'Recurring',
      update.startsAt.toISOString(),
      update.recurrence,
      update.timezone,
      update.nextDueAt?.toISOString() ?? null,
      now.toISOString(),
      input.id,
      current.state,
      currentRow.revision,
    ],
  );
  if (result.changes !== 1) {
    throw new Error('schedule update lost a concurrent state change');
  }
};

const updateSchedule = (
  database: Database,
  input: ScheduleUpdateInput,
  now: Date,
): ScheduleRecord => {
  const currentRow = selectScheduleRow(database, input.id);
  const current = scheduleRecord(currentRow);
  const update = resolveUpdate(input, current, currentRow, now);
  persistUpdate(database, input, current, currentRow, update, now);
  return selectSchedule(database, input.id);
};

export { updateSchedule };
