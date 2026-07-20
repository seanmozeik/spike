import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { InboundMessageId } from '../src/domain/ids';
import { claimSchedule } from '../src/schedule/scheduler-persistence';
import { cleanupScheduleJournalFixtures, makeJournalFixture } from './schedule-journal-fixture';

afterEach(() => {
  cleanupScheduleJournalFixtures();
});

it.effect('lists lifecycle states and never dispatches paused or cancelled schedules', () =>
  Effect.gen(function* scheduleLifecycle() {
    const fixture = yield* makeJournalFixture();
    const now = new Date('2026-07-19T12:00:00Z');
    const paused = yield* fixture.journal.create(
      {
        name: 'Pause me',
        oneShotAt: '2026-07-19T11:58:00Z',
        prompt: 'Paused prompt',
        timezone: 'UTC',
      },
      now,
    );
    const cancelled = yield* fixture.journal.create(
      {
        name: 'Cancel me',
        oneShotAt: '2026-07-19T11:59:00Z',
        prompt: 'Cancelled prompt',
        timezone: 'UTC',
      },
      now,
    );

    expect((yield* fixture.journal.list(false)).map(({ id }) => id)).toEqual([
      paused.id,
      cancelled.id,
    ]);
    expect((yield* fixture.journal.pause(paused.id, now)).state).toBe('Paused');
    expect((yield* fixture.journal.due(now))?.id).toBe(cancelled.id);
    expect((yield* fixture.journal.cancel(cancelled.id, now)).state).toBe('Cancelled');
    expect(yield* fixture.journal.due(now)).toBeNull();
    expect((yield* fixture.journal.list(false)).map(({ id, state }) => ({ id, state }))).toEqual([
      { id: paused.id, state: 'Paused' },
    ]);
    expect((yield* fixture.journal.list(true)).map(({ id, state }) => ({ id, state }))).toEqual([
      { id: paused.id, state: 'Paused' },
      { id: cancelled.id, state: 'Cancelled' },
    ]);

    expect((yield* fixture.journal.resume(paused.id, now)).state).toBe('Active');
    expect((yield* fixture.journal.due(now))?.id).toBe(paused.id);
    yield* fixture.journal.cancel(paused.id, now);
    expect(yield* fixture.journal.due(now)).toBeNull();
    expect(yield* fixture.journal.list(false)).toStrictEqual([]);
    fixture.handle.close();
  }),
);

const assertInactiveStateWinsDueRace = Effect.fn('Test.assertInactiveStateWinsDueRace')(
  function* inactiveStateWinsDueRace(action: 'cancel' | 'pause') {
    const fixture = yield* makeJournalFixture();
    const now = new Date('2026-07-19T12:00:00Z');
    const created = yield* fixture.journal.create(
      { oneShotAt: '2026-07-19T11:59:00Z', prompt: `${action} race prompt`, timezone: 'UTC' },
      now,
    );
    const stale = yield* fixture.journal.due(now);
    if (stale === null) {
      throw new Error('expected due schedule before the lifecycle race');
    }

    const inactive = yield* fixture.journal[action](created.id, now);
    expect(inactive.state).toBe(action === 'pause' ? 'Paused' : 'Cancelled');
    expect(() => {
      claimSchedule(
        fixture.handle.database,
        {
          expectedDueAt: stale.expectedDueAt,
          expectedRevision: stale.expectedRevision,
          kind: 'ClaimSchedule',
          message: {
            attachments: [],
            id: InboundMessageId.make(`scheduled-inbound-${action}-race`),
            receivedAt: now,
            text: stale.prompt,
          },
          nextDueAt: null,
          runId: `scheduled-run-${action}-race`,
          scheduleId: stale.id,
          scheduledFor: stale.expectedDueAt,
        },
        now.toISOString(),
      );
    }).toThrow('lost its active occurrence');
    expect(
      fixture.handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM scheduled_runs')
        .get(),
    ).toStrictEqual({ count: 0 });
    expect(
      fixture.handle.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM inbound_messages WHERE source_kind = 'ScheduleRun'",
        )
        .get(),
    ).toStrictEqual({ count: 0 });
    fixture.handle.close();
  },
);

it.effect('pause wins a race against a stale due snapshot', () =>
  assertInactiveStateWinsDueRace('pause'),
);

it.effect('cancel wins a race against a stale due snapshot', () =>
  assertInactiveStateWinsDueRace('cancel'),
);
