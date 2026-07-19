import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { initialDueAt, instant, recurrenceCursor, validTimezone } from '../src/schedule/recurrence';

interface LocalStamp {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly offset: string;
  readonly year: number;
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

const requiredDate = (value: Date | null): Date => {
  if (value === null) {
    throw new Error('expected a recurrence date');
  }
  return value;
};

const localStamp = (value: Date, timezone: string): LocalStamp => {
  const zoned = Temporal.Instant.from(value.toISOString()).toZonedDateTimeISO(timezone);
  return {
    day: zoned.day,
    hour: zoned.hour,
    minute: zoned.minute,
    month: zoned.month,
    offset: zoned.offset,
    year: zoned.year,
  };
};

describe('schedule recurrence input validation', () => {
  it('accepts complete absolute timestamps and preserves their instant', () => {
    expect(instant('2026-07-19T10:11:12Z', 'oneShotAt').toISOString()).toBe(
      '2026-07-19T10:11:12.000Z',
    );
    expect(instant('2026-07-19T10:11:12.345+01:30', 'oneShotAt').toISOString()).toBe(
      '2026-07-19T08:41:12.345Z',
    );
  });

  it.each([
    '2026-07-19',
    '2026-07-19T10:11:12',
    '2026-07-19 10:11:12Z',
    'July 19 2026 10:11:12 UTC',
    '2026-07-19T10:11:12z',
  ])('rejects an offsetless or non-canonical timestamp: %s', (value): void => {
    expect(() => instant(value, 'oneShotAt')).toThrow(
      'oneShotAt must be a complete ISO timestamp with an explicit offset',
    );
  });

  it.each([
    '2026-02-30T10:00:00Z',
    '2026-13-01T10:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T10:00:00+24:00',
  ])('rejects an impossible absolute timestamp: %s', (value): void => {
    expect(() => instant(value, 'oneShotAt')).toThrow(
      'oneShotAt must be an ISO timestamp with an offset',
    );
  });

  it('validates IANA timezone identifiers before recurrence evaluation', () => {
    expect(validTimezone('Europe/London')).toBe(true);
    expect(validTimezone('America/New_York')).toBe(true);
    expect(validTimezone('UTC')).toBe(true);
    expect(validTimezone('Europe/Not-A-City')).toBe(false);
    expect(validTimezone('')).toBe(false);
    expect(() =>
      recurrenceCursor(
        'FREQ=DAILY',
        new Date('2026-01-01T10:00:00Z'),
        'Europe/Not-A-City',
        new Date('2026-01-02T10:00:00Z'),
      ),
    ).toThrow('unknown IANA timezone Europe/Not-A-City');
  });
});

describe('bounded RRULE validation', () => {
  const startsAt = new Date('2026-01-01T10:15:30Z');
  const now = new Date('2026-01-01T10:16:31Z');

  it.each([
    ['', /one bounded RRULE expression/u],
    ['RRULE:', /one bounded RRULE expression/u],
    ['FREQ=DAILY\nCOUNT=2', /one bounded RRULE expression/u],
    ['COUNT=2', /one supported FREQ/u],
    ['FREQ=', /malformed field/u],
    ['FREQ=DAILY;BROKEN', /malformed field/u],
    ['FREQ=DAILY;FREQ=WEEKLY', /repeats FREQ/u],
    ['FREQ=DAILY;COUNT=2;COUNT=3', /repeats COUNT/u],
    ['FREQ=FORTNIGHTLY', /one supported FREQ/u],
    ['FREQ=SECONDLY', /second-level schedules are not supported/u],
    ['FREQ=DAILY;COUNT=0', /COUNT must be an integer from 1 through 1000/u],
    ['FREQ=DAILY;COUNT=-1', /COUNT must be an integer from 1 through 1000/u],
    ['FREQ=DAILY;COUNT=1.5', /COUNT must be an integer from 1 through 1000/u],
    ['FREQ=DAILY;COUNT=lots', /COUNT must be an integer from 1 through 1000/u],
    ['FREQ=DAILY;COUNT=1001', /COUNT must be an integer from 1 through 1000/u],
    ['FREQ=MINUTELY;INTERVAL=0', /interval must be greater than 0/u],
  ] as const)('rejects %s', (rrule, expected): void => {
    expect(() => recurrenceCursor(rrule, startsAt, 'UTC', now)).toThrow(expected);
  });

  it('rejects oversized rules before parsing fields', () => {
    const oversized = `FREQ=DAILY;X=${'A'.repeat(2000)}`;
    expect(() => recurrenceCursor(oversized, startsAt, 'UTC', now)).toThrow(
      'rrule must be one bounded RRULE expression',
    );
  });

  it('allows bounded minute and hour cadence while retaining anchor components', () => {
    const minute = recurrenceCursor('RRULE:FREQ=MINUTELY;COUNT=3', startsAt, 'UTC', now);
    expect(iso(minute.due)).toBe('2026-01-01T10:16:30.000Z');
    expect(iso(minute.next)).toBe('2026-01-01T10:17:30.000Z');

    const hour = recurrenceCursor('FREQ=HOURLY;COUNT=3', startsAt, 'UTC', now);
    expect(iso(hour.due)).toBe('2026-01-01T10:15:30.000Z');
    expect(iso(hour.next)).toBe('2026-01-01T11:15:30.000Z');
  });

  it('accepts the maximum bounded COUNT', () => {
    const cursor = recurrenceCursor('FREQ=DAILY;COUNT=1000', startsAt, 'UTC', startsAt);
    expect(iso(cursor.due)).toBe('2026-01-01T10:15:30.000Z');
    expect(iso(cursor.next)).toBe('2026-01-02T10:15:30.000Z');
  });
});

describe('recurrence selection and London wall-clock policy', () => {
  it('selects only the latest missed occurrence and the next future occurrence', () => {
    const startsAt = new Date('2026-01-01T09:00:00Z');
    const now = new Date('2026-01-04T12:00:00Z');
    const cursor = recurrenceCursor('FREQ=DAILY;COUNT=5', startsAt, 'UTC', now);

    expect(iso(cursor.due)).toBe('2026-01-04T09:00:00.000Z');
    expect(iso(cursor.next)).toBe('2026-01-05T09:00:00.000Z');
    expect(iso(initialDueAt('FREQ=DAILY;COUNT=5', startsAt, 'UTC', now))).toBe(
      '2026-01-04T09:00:00.000Z',
    );
  });

  it('selects the first future occurrence before the anchor and the anchor for a one-shot', () => {
    const startsAt = new Date('2026-01-01T09:00:00Z');
    const before = new Date('2025-12-31T23:59:59Z');
    const cursor = recurrenceCursor('FREQ=DAILY;COUNT=2', startsAt, 'UTC', before);

    expect(cursor.due).toBeNull();
    expect(iso(cursor.next)).toBe('2026-01-01T09:00:00.000Z');
    expect(iso(initialDueAt('FREQ=DAILY;COUNT=2', startsAt, 'UTC', before))).toBe(
      '2026-01-01T09:00:00.000Z',
    );
    expect(iso(initialDueAt(null, startsAt, 'UTC', before))).toBe('2026-01-01T09:00:00.000Z');
  });

  it('returns no next occurrence after COUNT is exhausted', () => {
    const cursor = recurrenceCursor(
      'FREQ=DAILY;COUNT=2',
      new Date('2026-01-01T09:00:00Z'),
      'UTC',
      new Date('2026-01-03T12:00:00Z'),
    );
    expect(iso(cursor.due)).toBe('2026-01-02T09:00:00.000Z');
    expect(cursor.next).toBeNull();
  });

  it('counts the spring gap at 02:30 then returns to the 01:30 London wall time', () => {
    const startsAt = new Date('2026-03-28T01:30:00Z');
    const afterGap = recurrenceCursor(
      'FREQ=DAILY;COUNT=4',
      startsAt,
      'Europe/London',
      new Date('2026-03-29T01:31:00Z'),
    );

    expect(iso(afterGap.due)).toBe('2026-03-29T01:30:00.000Z');
    expect(localStamp(requiredDate(afterGap.due), 'Europe/London')).toStrictEqual({
      day: 29,
      hour: 2,
      minute: 30,
      month: 3,
      offset: '+01:00',
      year: 2026,
    });
    expect(iso(afterGap.next)).toBe('2026-03-30T00:30:00.000Z');
    expect(localStamp(requiredDate(afterGap.next), 'Europe/London')).toMatchObject({
      day: 30,
      hour: 1,
      minute: 30,
    });

    const completed = recurrenceCursor(
      'FREQ=DAILY;COUNT=4',
      startsAt,
      'Europe/London',
      new Date('2026-04-01T00:00:00Z'),
    );
    expect(iso(completed.due)).toBe('2026-03-31T00:30:00.000Z');
    expect(completed.next).toBeNull();
  });

  it('chooses the first 01:30 during the London autumn overlap', () => {
    const cursor = recurrenceCursor(
      'FREQ=DAILY;COUNT=4',
      new Date('2026-10-24T00:30:00Z'),
      'Europe/London',
      new Date('2026-10-25T01:31:00Z'),
    );

    expect(iso(cursor.due)).toBe('2026-10-25T00:30:00.000Z');
    expect(localStamp(requiredDate(cursor.due), 'Europe/London')).toStrictEqual({
      day: 25,
      hour: 1,
      minute: 30,
      month: 10,
      offset: '+01:00',
      year: 2026,
    });
    expect(iso(cursor.next)).toBe('2026-10-26T01:30:00.000Z');
  });
});
