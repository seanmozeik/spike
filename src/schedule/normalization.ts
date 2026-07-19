import { canonicalRRule, initialDueAt, instant, unfiredDueAt, validTimezone } from './recurrence';

interface NormalizedSchedule {
  readonly dueAt: Date;
  readonly recurrence: null | string;
  readonly startsAt: Date;
}

const scheduleShape = (
  oneShotAt: string,
  rrule: null | string,
  timezone: string,
): Omit<NormalizedSchedule, 'dueAt'> => {
  if (!validTimezone(timezone)) {
    throw new Error(`unknown IANA timezone ${timezone}`);
  }
  const startsAt = instant(oneShotAt, 'oneShotAt');
  const recurrence = rrule === null ? null : canonicalRRule(rrule, startsAt, timezone);
  return { recurrence, startsAt };
};

const normalizeInitialSchedule = (
  oneShotAt: string,
  rrule: null | string,
  timezone: string,
  now: Date,
): NormalizedSchedule => {
  const shape = scheduleShape(oneShotAt, rrule, timezone);
  const dueAt = initialDueAt(shape.recurrence, shape.startsAt, timezone, now);
  if (dueAt === null) {
    throw new Error('schedule has no remaining occurrence');
  }
  return { ...shape, dueAt };
};

const normalizeUnfiredSchedule = (
  oneShotAt: string,
  rrule: null | string,
  timezone: string,
  now: Date,
  lastRunAt: Date | null,
): NormalizedSchedule => {
  const shape = scheduleShape(oneShotAt, rrule, timezone);
  const dueAt = unfiredDueAt(shape.recurrence, shape.startsAt, timezone, now, lastRunAt);
  if (dueAt === null) {
    throw new Error('schedule has no remaining occurrence');
  }
  return { ...shape, dueAt };
};

export { normalizeInitialSchedule, normalizeUnfiredSchedule };
