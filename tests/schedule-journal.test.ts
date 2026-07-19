import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { InboundMessageId } from '../src/domain/ids';
import { claimSchedule } from '../src/schedule/scheduler-persistence';
import { cleanupScheduleJournalFixtures, makeJournalFixture } from './schedule-journal-fixture';

afterEach(() => {
  cleanupScheduleJournalFixtures();
});

it.effect('preserves the advanced occurrence on a prompt-only recurring update', () =>
  Effect.gen(function* preserveAdvancedOccurrence() {
    const fixture = yield* makeJournalFixture();
    const created = yield* fixture.journal.create(
      {
        oneShotAt: '2026-07-18T09:00:00Z',
        prompt: 'Original prompt',
        rrule: 'FREQ=DAILY',
        timezone: 'Europe/London',
      },
      new Date('2026-07-19T10:00:00Z'),
    );
    expect(created.nextDueAt?.toISOString()).toBe('2026-07-19T09:00:00.000Z');
    const firstOccurrence = created.nextDueAt ?? new Date(0);
    const secondOccurrence = new Date('2026-07-20T09:00:00.000Z');
    claimSchedule(
      fixture.handle.database,
      {
        expectedDueAt: firstOccurrence,
        expectedRevision: 0,
        kind: 'ClaimSchedule',
        message: {
          attachments: [],
          id: InboundMessageId.make('scheduled-inbound-one'),
          receivedAt: firstOccurrence,
          text: 'Original prompt',
        },
        nextDueAt: secondOccurrence,
        runId: 'scheduled-run-one',
        scheduleId: created.id,
        scheduledFor: firstOccurrence,
      },
      new Date('2026-07-19T10:00:00Z').toISOString(),
    );

    const updated = yield* fixture.journal.update(
      { id: created.id, prompt: 'Updated prompt' },
      new Date('2026-07-19T12:00:00Z'),
    );
    expect(updated.nextDueAt?.toISOString()).toBe(secondOccurrence.toISOString());

    claimSchedule(
      fixture.handle.database,
      {
        expectedDueAt: secondOccurrence,
        expectedRevision: 2,
        kind: 'ClaimSchedule',
        message: {
          attachments: [],
          id: InboundMessageId.make('scheduled-inbound-two'),
          receivedAt: secondOccurrence,
          text: 'Updated prompt',
        },
        nextDueAt: new Date('2026-07-21T09:00:00.000Z'),
        runId: 'scheduled-run-two',
        scheduleId: created.id,
        scheduledFor: secondOccurrence,
      },
      secondOccurrence.toISOString(),
    );
    expect(
      fixture.handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM scheduled_runs')
        .get(),
    ).toStrictEqual({ count: 2 });
    fixture.handle.close();
  }),
);

it.effect('recomputes cadence edits strictly after both now and the last run', () =>
  Effect.gen(function* futureCadenceEdit() {
    const fixture = yield* makeJournalFixture();
    const created = yield* fixture.journal.create(
      { oneShotAt: '2026-07-19T09:00:00Z', prompt: 'Run it', rrule: 'FREQ=DAILY', timezone: 'UTC' },
      new Date('2026-07-19T10:00:00Z'),
    );
    fixture.handle.database.run(
      'UPDATE schedules SET last_run_at = ?, next_due_at = ? WHERE id = ?',
      ['2026-07-20T09:00:00.000Z', '2026-07-21T09:00:00.000Z', created.id],
    );
    const updated = yield* fixture.journal.update(
      { id: created.id, rrule: 'FREQ=HOURLY' },
      new Date('2026-07-19T12:00:00Z'),
    );
    expect(updated.nextDueAt?.getTime()).toBeGreaterThan(
      new Date('2026-07-20T09:00:00.000Z').getTime(),
    );
    fixture.handle.close();
  }),
);

it.effect('keeps an unfired one-shot due when it is edited into the past', () =>
  Effect.gen(function* unfiredPastOneShot() {
    const fixture = yield* makeJournalFixture();
    const created = yield* fixture.journal.create(
      { oneShotAt: '2026-07-20T12:00:00Z', prompt: 'Run it once', timezone: 'UTC' },
      new Date('2026-07-19T12:00:00Z'),
    );

    const updated = yield* fixture.journal.update(
      { id: created.id, oneShotAt: '2026-07-19T11:59:00Z' },
      new Date('2026-07-19T12:00:00Z'),
    );

    expect(updated.nextDueAt?.toISOString()).toBe('2026-07-19T11:59:00.000Z');
    expect((yield* fixture.journal.due(new Date('2026-07-19T12:00:00Z')))?.id).toBe(created.id);
    fixture.handle.close();
  }),
);

it.effect('uses the latest missed occurrence for a never-run cadence edit', () =>
  Effect.gen(function* latestMissedCadence() {
    const fixture = yield* makeJournalFixture();
    const created = yield* fixture.journal.create(
      { oneShotAt: '2026-07-20T10:15:00Z', prompt: 'Run it repeatedly', timezone: 'UTC' },
      new Date('2026-07-19T12:00:00Z'),
    );

    const updated = yield* fixture.journal.update(
      { id: created.id, oneShotAt: '2026-07-18T10:15:00Z', rrule: 'FREQ=HOURLY' },
      new Date('2026-07-19T12:34:00Z'),
    );

    expect(updated.nextDueAt?.toISOString()).toBe('2026-07-19T12:15:00.000Z');
    fixture.handle.close();
  }),
);

it.effect('rejects a stale due prompt by revision and enqueues the refreshed prompt once', () =>
  Effect.gen(function* duePromptRevision() {
    const fixture = yield* makeJournalFixture();
    const now = new Date('2026-07-19T12:00:00Z');
    const created = yield* fixture.journal.create(
      { oneShotAt: '2026-07-19T11:59:00Z', prompt: 'Old prompt', timezone: 'UTC' },
      now,
    );
    const stale = yield* fixture.journal.due(now);
    if (stale === null) {
      throw new Error('expected due schedule');
    }
    yield* fixture.journal.update({ id: created.id, prompt: 'New prompt' }, now);

    expect(() => {
      claimSchedule(
        fixture.handle.database,
        {
          expectedDueAt: stale.expectedDueAt,
          expectedRevision: stale.expectedRevision,
          kind: 'ClaimSchedule',
          message: {
            attachments: [],
            id: InboundMessageId.make('scheduled-inbound-stale'),
            receivedAt: stale.expectedDueAt,
            text: stale.prompt,
          },
          nextDueAt: null,
          runId: 'scheduled-run-stale',
          scheduleId: stale.id,
          scheduledFor: stale.expectedDueAt,
        },
        now.toISOString(),
      );
    }).toThrow('lost its active occurrence');

    const refreshed = yield* fixture.journal.due(now);
    if (refreshed === null) {
      throw new Error('expected refreshed due schedule');
    }
    claimSchedule(
      fixture.handle.database,
      {
        expectedDueAt: refreshed.expectedDueAt,
        expectedRevision: refreshed.expectedRevision,
        kind: 'ClaimSchedule',
        message: {
          attachments: [],
          id: InboundMessageId.make('scheduled-inbound-refreshed'),
          receivedAt: refreshed.expectedDueAt,
          text: refreshed.prompt,
        },
        nextDueAt: null,
        runId: 'scheduled-run-refreshed',
        scheduleId: refreshed.id,
        scheduledFor: refreshed.expectedDueAt,
      },
      now.toISOString(),
    );

    expect(
      fixture.handle.database
        .query<{ text: string }, []>(
          "SELECT text FROM inbound_messages WHERE source_kind = 'ScheduleRun'",
        )
        .all(),
    ).toStrictEqual([{ text: 'New prompt' }]);
    expect(
      fixture.handle.database
        .query<{ revision: number; state: string }, [string]>(
          'SELECT revision, state FROM schedules WHERE id = ?',
        )
        .get(created.id),
    ).toStrictEqual({ revision: 2, state: 'Completed' });
    fixture.handle.close();
  }),
);

it.effect('clears a schedule name only when update explicitly supplies null', () =>
  Effect.gen(function* clearScheduleName() {
    const fixture = yield* makeJournalFixture();
    const created = yield* fixture.journal.create(
      {
        name: 'Morning check',
        oneShotAt: '2026-07-20T12:00:00Z',
        prompt: 'Check it',
        timezone: 'UTC',
      },
      new Date('2026-07-19T12:00:00Z'),
    );
    const preserved = yield* fixture.journal.update(
      { id: created.id, prompt: 'Check it carefully' },
      new Date('2026-07-19T12:01:00Z'),
    );
    expect(preserved.name).toBe('Morning check');

    const cleared = yield* fixture.journal.update(
      { id: created.id, name: null },
      new Date('2026-07-19T12:02:00Z'),
    );
    expect(cleared.name).toBeNull();
    fixture.handle.close();
  }),
);
