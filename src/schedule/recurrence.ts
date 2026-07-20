import { RRuleTemporal } from 'rrule-temporal';
import { Temporal } from 'temporal-polyfill';

import { isValidIanaTimezone } from '../timezone';

interface RecurrenceCursor {
  readonly due: Date | null;
  readonly next: Date | null;
}

const MAX_RRULE_COUNT = 1000;
const MAX_RRULE_ITERATIONS = 20_000;
const MAX_RRULE_LENGTH = 2000;
const SUPPORTED_FREQUENCIES = new Set([
  'YEARLY',
  'MONTHLY',
  'WEEKLY',
  'DAILY',
  'HOURLY',
  'MINUTELY',
  'SECONDLY',
]);

const instant = (value: string, field: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new Error(`${field} must be a complete ISO timestamp with an explicit offset`);
  }
  try {
    const parsed = Temporal.Instant.from(value);
    return new Date(parsed.epochMilliseconds);
  } catch {
    throw new Error(`${field} must be an ISO timestamp with an offset`);
  }
};

const normalizeRule = (value: string): string => {
  const normalized = value
    .trim()
    .replace(/^RRULE:/iu, '')
    .toUpperCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_RRULE_LENGTH ||
    normalized.includes('\n')
  ) {
    throw new Error('rrule must be one bounded RRULE expression');
  }
  return normalized;
};

const parseFields = (normalized: string): Map<string, string> => {
  const fields = new Map<string, string>();
  for (const part of normalized.split(';')) {
    const separator = part.indexOf('=');
    const key = part.slice(0, separator);
    const fieldValue = part.slice(separator + 1);
    if (separator <= 0 || fieldValue === '' || !/^[A-Z]+$/u.test(key)) {
      throw new Error('rrule contains a malformed field');
    }
    if (fields.has(key)) {
      throw new Error(`rrule repeats ${key}`);
    }
    fields.set(key, fieldValue);
  }
  return fields;
};

const validatedFrequency = (fields: ReadonlyMap<string, string>): string => {
  const frequency = fields.get('FREQ');
  if (frequency === undefined || !SUPPORTED_FREQUENCIES.has(frequency)) {
    throw new Error('rrule must contain one supported FREQ');
  }
  if (frequency === 'SECONDLY') {
    throw new Error('second-level schedules are not supported');
  }
  return frequency;
};

const validateCount = (fields: ReadonlyMap<string, string>): void => {
  const countText = fields.get('COUNT');
  if (countText === undefined) {
    return;
  }
  const count = Number(countText);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RRULE_COUNT) {
    throw new Error(`rrule COUNT must be an integer from 1 through ${String(MAX_RRULE_COUNT)}`);
  }
};

const defaultStartIndex = (frequency: string): number => {
  if (frequency === 'MINUTELY') {
    return 2;
  }
  if (frequency === 'HOURLY') {
    return 1;
  }
  return 0;
};

const applyTimeDefaults = (
  fields: Map<string, string>,
  frequency: string,
  startsAt: Temporal.ZonedDateTime,
): void => {
  const defaults: readonly [string, number][] = [
    ['BYHOUR', startsAt.hour],
    ['BYMINUTE', startsAt.minute],
    ['BYSECOND', startsAt.second],
  ];
  for (const [key, fallback] of defaults.slice(defaultStartIndex(frequency))) {
    if (!fields.has(key)) {
      fields.set(key, String(fallback));
    }
  }
};

const compareFields = (
  [left]: readonly [string, string],
  [right]: readonly [string, string],
): number => {
  if (left === 'FREQ') {
    return -1;
  }
  if (right === 'FREQ') {
    return 1;
  }
  return left.localeCompare(right);
};

const boundedRule = (value: string, startsAt: Temporal.ZonedDateTime): string => {
  const fields = parseFields(normalizeRule(value));
  const frequency = validatedFrequency(fields);
  validateCount(fields);
  applyTimeDefaults(fields, frequency, startsAt);
  return [...fields]
    .toSorted(compareFields)
    .map(([key, fieldValue]) => `${key}=${fieldValue}`)
    .join(';');
};

const zoned = (value: Date, timezone: string): Temporal.ZonedDateTime =>
  Temporal.Instant.from(value.toISOString()).toZonedDateTimeISO(timezone);

const canonicalRRule = (rrule: string, startsAt: Date, timezone: string): string => {
  if (!isValidIanaTimezone(timezone)) {
    throw new Error(`unknown IANA timezone ${timezone}`);
  }
  return boundedRule(rrule, zoned(startsAt, timezone));
};

const rule = (rrule: string, startsAt: Date, timezone: string): RRuleTemporal => {
  if (!isValidIanaTimezone(timezone)) {
    throw new Error(`unknown IANA timezone ${timezone}`);
  }
  const start = zoned(startsAt, timezone);
  return new RRuleTemporal({
    dtstart: start,
    maxIterations: MAX_RRULE_ITERATIONS,
    rruleString: canonicalRRule(rrule, startsAt, timezone),
    strict: true,
    tzid: timezone,
  });
};

const occurrenceDate = (value: ReturnType<RRuleTemporal['next']>): Date | null =>
  value === null ? null : new Date(value.epochMilliseconds);

const recurrenceCursor = (
  rrule: string,
  startsAt: Date,
  timezone: string,
  now: Date,
): RecurrenceCursor => {
  const recurrence = rule(rrule, startsAt, timezone);
  const due = occurrenceDate(recurrence.previous(now, true));
  const next = occurrenceDate(recurrence.next(now, false));
  return { due, next };
};

const initialDueAt = (
  rrule: null | string,
  startsAt: Date,
  timezone: string,
  now: Date,
): Date | null => {
  if (rrule === null) {
    return startsAt;
  }
  const cursor = recurrenceCursor(rrule, startsAt, timezone, now);
  return cursor.due ?? cursor.next;
};

const futureDueAt = (
  rrule: null | string,
  startsAt: Date,
  timezone: string,
  after: Date,
): Date | null => {
  if (rrule === null) {
    return startsAt > after ? startsAt : null;
  }
  return recurrenceCursor(rrule, startsAt, timezone, after).next;
};

const unfiredDueAt = (
  rrule: null | string,
  startsAt: Date,
  timezone: string,
  now: Date,
  lastRunAt: Date | null,
): Date | null => {
  const initial = initialDueAt(rrule, startsAt, timezone, now);
  if (lastRunAt === null || (initial !== null && initial > lastRunAt)) {
    return initial;
  }
  const latestBoundary = Math.max(now.getTime(), lastRunAt.getTime());
  return futureDueAt(rrule, startsAt, timezone, new Date(latestBoundary));
};

const formatLocal = (date: Date, timezone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'long',
    timeZone: timezone,
  }).format(date);

export {
  canonicalRRule,
  formatLocal,
  futureDueAt,
  initialDueAt,
  instant,
  recurrenceCursor,
  unfiredDueAt,
};
export type { RecurrenceCursor };
