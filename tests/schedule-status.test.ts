import { Effect } from 'effect';
import { expect, it } from 'vitest';

import { makeDoctorReport } from '../src/status/doctor';
import { formatDoctor, formatStatus, relativeTime } from '../src/status/format';
import { isStatusSnapshot, makeStatusSnapshot } from '../src/status/snapshot';
import { NOW, OLD } from './retention-fixture';
import {
  makeScheduleStatusRetentionFixture,
  NEXT_DUE,
  RAW_TOOL_ARGUMENT_SECRET,
  STATUS_SECRETS,
  successfulCommands,
} from './schedule-status-retention-fixture';

it('reports bounded schedule diagnostics without exposing durable payloads', async () => {
  const fixture = await Effect.runPromise(makeScheduleStatusRetentionFixture());
  try {
    const status = await makeStatusSnapshot(
      fixture.database,
      fixture.paths,
      OLD.toISOString(),
      null,
    );
    expect(status.schedules).toStrictEqual({
      active: 2,
      cancelled: 1,
      completed: 1,
      nextDueAt: NEXT_DUE,
      paused: 1,
      queued: 1,
      running: 1,
    });
    expect(formatStatus(status)).toContain(
      'Schedules 2 active · 1 paused · 1 completed · 1 cancelled · runs 1 queued · 1 running',
    );
    expect(relativeTime(status.schedules?.nextDueAt ?? null, NOW.getTime())).toBe('in 1d');

    const { schedules: _schedules, ...legacyStatus } = status;
    expect(isStatusSnapshot(legacyStatus)).toBe(true);
    expect(
      isStatusSnapshot({
        ...status,
        schedules: {
          active: 2,
          cancelled: 1,
          completed: 1,
          nextDueAt: 7,
          paused: 1,
          queued: 1,
          running: 1,
        },
      }),
    ).toBe(false);
    expect(
      isStatusSnapshot({
        ...status,
        schedules: {
          active: 2,
          cancelled: 1,
          completed: 1,
          nextDueAt: NEXT_DUE,
          paused: 1,
          running: 1,
        },
      }),
    ).toBe(false);

    const report = await makeDoctorReport(
      fixture.paths,
      status,
      '/unused/helper',
      successfulCommands,
    );
    const schedule = report.checks.find(({ name }) => name === 'schedules');
    expect(schedule).toMatchObject({ name: 'schedules', state: 'pass' });
    expect(schedule?.detail).toContain('2 active');
    expect(schedule?.detail).toContain('1 paused');
    expect(schedule?.detail).toContain('1 completed');
    expect(schedule?.detail).toContain('1 cancelled');
    expect(schedule?.detail).toContain('1 queued');
    expect(schedule?.detail).toContain('1 running');
    expect(schedule?.detail).toContain(NEXT_DUE);

    const toolColumns = fixture.database
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('schedule_tool_calls')")
      .all()
      .map(({ name }) => name);
    expect(toolColumns).toEqual(
      expect.arrayContaining([
        'call_id',
        'request_hash',
        'response_json',
        'success',
        'created_at',
        'payload_redacted_at',
      ]),
    );
    expect(toolColumns.some((name) => /arg(?:ument)?s?/iu.test(name))).toBe(false);
    expect(
      JSON.stringify(fixture.database.query('SELECT * FROM schedule_tool_calls').all()),
    ).not.toContain(RAW_TOOL_ARGUMENT_SECRET);

    const rendered = [
      JSON.stringify(status),
      formatStatus(status),
      JSON.stringify(report),
      formatDoctor(report),
    ].join('\n');
    for (const secret of STATUS_SECRETS) {
      expect(rendered).not.toContain(secret);
    }
  } finally {
    fixture.close();
  }
});
