import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { openJournal } from '../src/database';
import { makeDeliveryJournal } from '../src/delivery/journal';
import { makeSchedulerJournal } from '../src/journal/scheduler-journal';
import { makeScheduleJournal } from '../src/schedule/journal';
import { dueEvent } from '../src/schedule/phase';
import type { SchedulerEvent, TurnIdentity } from '../src/scheduler/model';
import { transitionScheduler } from '../src/scheduler/transition';

const roots: string[] = [];
const NOW = new Date('2026-07-19T12:00:00.000Z');

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

type ScheduleDueEvent = Extract<SchedulerEvent, { readonly kind: 'ScheduleDue' }>;

interface CommittedSchedule {
  readonly event: ScheduleDueEvent;
  readonly identity: TurnIdentity;
}

const commitBeforeSideEffect = Effect.fn('Test.commitScheduleBeforeSideEffect')(
  function* commitScheduleBeforeSideEffect(databasePath: string) {
    const initialHandle = yield* openJournal(databasePath);
    const scheduler = makeSchedulerJournal(initialHandle.database);
    const initial = yield* scheduler.loadOrCreate(NOW);
    const scheduleJournal = makeScheduleJournal(initialHandle.database);
    yield* scheduleJournal.create(
      { oneShotAt: '2026-07-19T11:59:00.000Z', prompt: 'Run the durable task', timezone: 'UTC' },
      NOW,
    );
    const due = yield* scheduleJournal.due(NOW);
    if (due === null) {
      throw new Error('expected a due schedule');
    }
    const event = dueEvent(due, NOW);
    const transition = transitionScheduler(initial, event);
    expect(transition.actions.map(({ kind }) => kind)).toEqual(['ClaimSchedule', 'StartTurn']);
    yield* scheduler.commitTransition(transition, NOW);
    expect(
      initialHandle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM outbound_messages')
        .get(),
    ).toStrictEqual({ count: 0 });
    initialHandle.close();
    return {
      event,
      identity: { generationId: initial.generationId, logicalTurnId: event.nextLogicalTurnId },
    } satisfies CommittedSchedule;
  },
);

const recoverAndPrepareFinal = Effect.fn('Test.recoverCommittedSchedule')(
  function* recoverCommittedSchedule(databasePath: string, committed: CommittedSchedule) {
    const { event, identity } = committed;
    const restartedHandle = yield* openJournal(databasePath);
    const restartedScheduler = makeSchedulerJournal(restartedHandle.database);
    const restarted = yield* restartedScheduler.loadOrCreate(new Date(NOW.getTime() + 1));
    expect(restarted.active?.logicalTurnId).toBe(event.nextLogicalTurnId);
    expect(
      restartedHandle.database
        .query<
          {
            readonly id: string;
            readonly inbound_message_id: string;
            readonly logical_turn_id: null | string;
            readonly state: string;
          },
          []
        >('SELECT id, inbound_message_id, logical_turn_id, state FROM scheduled_runs')
        .get(),
    ).toStrictEqual({
      id: event.runId,
      inbound_message_id: event.message.id,
      logical_turn_id: event.nextLogicalTurnId,
      state: 'Running',
    });
    expect(
      restartedHandle.database
        .query<{ readonly id: string; readonly state: string }, []>(
          'SELECT id, state FROM logical_turns',
        )
        .get(),
    ).toStrictEqual({ id: event.nextLogicalTurnId, state: 'Running' });
    const delivery = makeDeliveryJournal(restartedHandle.database);
    expect(
      yield* delivery.prepareTurnNotice(identity, 'stable-final-item', 'Final', 'Done.', NOW),
    ).not.toBeNull();
    const finalCount = restartedHandle.database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count FROM outbound_messages
         WHERE logical_turn_id = ? AND source_kind = 'CodexAgentItem'
           AND source_id = 'stable-final-item' AND message_kind = 'Final'`,
      )
      .get(event.nextLogicalTurnId)?.count;
    restartedHandle.close();
    return finalCount;
  },
);

it.effect('recovers a committed scheduled turn with stable identities and one final outbound', () =>
  Effect.gen(function* recoverCommittedSchedule() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-schedule-commit-recovery-'));
    roots.push(root);
    const databasePath = path.join(root, 'spike.db');
    const committed = yield* commitBeforeSideEffect(databasePath);
    expect(yield* recoverAndPrepareFinal(databasePath, committed)).toBe(1);
    expect(yield* recoverAndPrepareFinal(databasePath, committed)).toBe(1);
  }),
);
