import { Effect } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { CodexTurnId } from '../src/domain/ids';
import {
  cleanupFixtures,
  createCall,
  makeFixture,
  publish,
} from './schedule-server-requests-fixture';

afterEach(() => {
  cleanupFixtures();
});

it('defers a same-chunk tool call until the exact turn acceptance is durable', async () => {
  const fixture = await Effect.runPromise(makeFixture());
  publish(fixture.trace.requestListeners, createCall('call-create', 'turn-current'));
  await Bun.sleep(0);
  expect(fixture.trace.responses).toStrictEqual([]);
  await Effect.runPromise(
    fixture.codex.acceptCodexTurn(
      fixture.attemptId,
      fixture.threadId,
      CodexTurnId.make('turn-current'),
    ),
  );
  fixture.requests.attemptAccepted();
  await Bun.sleep(0);

  expect(fixture.trace.responses).toHaveLength(1);
  expect(fixture.trace.responses[0]?.result).toMatchObject({ success: true });
  expect(
    fixture.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM schedules').get(),
  ).toStrictEqual({ count: 1 });
  expect(fixture.mutations()).toBe(1);
  fixture.requests.close();
});

it('times out and durably rejects an unaccepted tool call', async () => {
  const fixture = await Effect.runPromise(makeFixture());
  publish(fixture.trace.requestListeners, createCall('call-timeout', 'turn-never-accepted'));
  fixture.scheduled.runNext();
  expect(fixture.trace.responses).toHaveLength(1);
  expect(JSON.stringify(fixture.trace.responses[0]?.result)).toContain(
    'timed out before turn acceptance',
  );
  expect(
    fixture.database
      .query<{ success: number }, []>(
        "SELECT success FROM schedule_tool_calls WHERE call_id = 'call-timeout'",
      )
      .get(),
  ).toStrictEqual({ success: 0 });
  fixture.requests.close();
});

it('persists a deterministic failure for stale turns and rejects call-id drift', async () => {
  const fixture = await Effect.runPromise(makeFixture());
  await Effect.runPromise(
    fixture.codex.acceptCodexTurn(
      fixture.attemptId,
      fixture.threadId,
      CodexTurnId.make('turn-current'),
    ),
  );
  fixture.requests.attemptAccepted();
  publish(fixture.trace.requestListeners, createCall('call-late', 'turn-old'));
  await Bun.sleep(0);
  publish(
    fixture.trace.requestListeners,
    createCall('call-late', 'turn-old', 'Different arguments'),
  );
  publish(fixture.trace.requestListeners, createCall('call-late', 'turn-old'));
  await Bun.sleep(0);

  const [late, drift, exactReplay] = fixture.trace.responses.map(({ result }) => result);
  expect(late).toMatchObject({ success: false });
  expect(JSON.stringify(late)).toContain('inactive conversation');
  expect(drift).toMatchObject({ success: false });
  expect(JSON.stringify(drift)).toContain('reused with different arguments');
  expect(exactReplay).toMatchObject({ success: false });
  expect(JSON.stringify(exactReplay)).toContain('inactive conversation');
  expect(
    fixture.database
      .query<{ response_json: string; success: number }, []>(
        "SELECT response_json, success FROM schedule_tool_calls WHERE call_id = 'call-late'",
      )
      .get(),
  ).toMatchObject({ success: 0 });
  expect(fixture.mutations()).toBe(0);
  fixture.requests.close();
});

it('never replays a successful response after its conversation becomes inactive', async () => {
  const fixture = await Effect.runPromise(makeFixture());
  await Effect.runPromise(
    fixture.codex.acceptCodexTurn(
      fixture.attemptId,
      fixture.threadId,
      CodexTurnId.make('turn-current'),
    ),
  );
  fixture.requests.attemptAccepted();
  const original = createCall('call-success-then-stale', 'turn-current');
  publish(fixture.trace.requestListeners, original);
  await Bun.sleep(0);
  fixture.database.run(
    'UPDATE scheduler_state SET active_logical_turn_id = NULL WHERE singleton = 1',
  );

  publish(fixture.trace.requestListeners, original);
  publish(
    fixture.trace.requestListeners,
    createCall('call-success-then-stale', 'turn-current', 'Changed stale arguments'),
  );
  fixture.database.run(
    "UPDATE scheduler_state SET active_logical_turn_id = 'logical-current' WHERE singleton = 1",
  );
  publish(fixture.trace.requestListeners, original);
  await Bun.sleep(0);

  expect(fixture.trace.responses).toHaveLength(4);
  expect(fixture.trace.responses[0]?.result).toMatchObject({ success: true });
  expect(fixture.trace.responses[1]?.result).toMatchObject({ success: false });
  expect(JSON.stringify(fixture.trace.responses[1]?.result)).toContain('inactive conversation');
  expect(fixture.trace.responses[2]?.result).toMatchObject({ success: false });
  expect(JSON.stringify(fixture.trace.responses[2]?.result)).toContain(
    'reused with different arguments',
  );
  expect(fixture.trace.responses[3]?.result).toEqual(fixture.trace.responses[0]?.result);
  expect(
    fixture.database
      .query<{ response_json: string; success: number }, []>(
        "SELECT response_json, success FROM schedule_tool_calls WHERE call_id = 'call-success-then-stale'",
      )
      .get(),
  ).toMatchObject({ success: 1 });
  expect(
    fixture.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM schedules').get(),
  ).toStrictEqual({ count: 1 });
  fixture.requests.close();
});
