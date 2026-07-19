import { Effect } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { CodexTurnId } from '../src/domain/ids';
import {
  cleanupFixtures,
  createCall,
  makeFixture,
  NOW,
  publish,
} from './schedule-server-requests-fixture';

afterEach(() => {
  cleanupFixtures();
});

it('returns the injected current time as whole Unix epoch seconds', async () => {
  const fixture = await Effect.runPromise(makeFixture());
  for (const listener of fixture.trace.requestListeners) {
    listener({ id: 6, method: 'currentTime/read', params: { threadId: 'thread-current' } });
  }
  await Bun.sleep(0);
  expect(fixture.trace.responses).toStrictEqual([
    { id: 6, result: { currentTimeAt: Math.floor(NOW.getTime() / 1000) } },
  ]);
  expect(fixture.errors).toStrictEqual([]);
  fixture.requests.close();
});

it('returns a JSON-RPC invalid-params error for malformed current-time reads', async () => {
  const fixture = await Effect.runPromise(makeFixture());
  for (const listener of fixture.trace.requestListeners) {
    listener({ id: 7, method: 'currentTime/read', params: {} });
  }
  await Bun.sleep(0);
  expect(fixture.trace.responses).toStrictEqual([
    { id: 7, result: { error: { code: -32_602, message: 'Invalid currentTime/read params' } } },
  ]);
  expect(fixture.errors).toHaveLength(1);
  fixture.requests.close();
});

it('contains an authorization fault during initial request handling', async () => {
  const fixture = await Effect.runPromise(makeFixture());
  fixture.database.run('DROP TABLE scheduler_state');

  expect(() => {
    publish(fixture.trace.requestListeners, createCall('call-initial-fault', 'turn-current'));
  }).not.toThrow();
  await Bun.sleep(0);

  expect(fixture.trace.responses).toHaveLength(1);
  expect(JSON.stringify(fixture.trace.responses[0]?.result)).toContain('authorization failed');
  expect(
    fixture.database
      .query<{ success: number }, []>(
        "SELECT success FROM schedule_tool_calls WHERE call_id = 'call-initial-fault'",
      )
      .get(),
  ).toStrictEqual({ success: 0 });
  expect(fixture.errors).toHaveLength(1);
  fixture.requests.close();
});

it('contains an authorization fault while lifecycle acceptance flushes a request', async () => {
  const fixture = await Effect.runPromise(makeFixture());
  publish(fixture.trace.requestListeners, createCall('call-flush-fault', 'turn-current'));
  fixture.database.run('DROP TABLE scheduler_state');

  const acceptance = fixture.codex.acceptCodexTurn(
    fixture.attemptId,
    fixture.threadId,
    CodexTurnId.make('turn-current'),
  );
  await expect(Effect.runPromise(acceptance)).resolves.toBeUndefined();
  fixture.requests.attemptAccepted();
  await Bun.sleep(0);

  expect(fixture.trace.responses).toHaveLength(1);
  expect(JSON.stringify(fixture.trace.responses[0]?.result)).toContain('authorization failed');
  expect(
    fixture.database
      .query<{ success: number }, []>(
        "SELECT success FROM schedule_tool_calls WHERE call_id = 'call-flush-fault'",
      )
      .get(),
  ).toStrictEqual({ success: 0 });
  fixture.requests.close();
});

it('contains an executor fault in the pending timeout callback', async () => {
  const fixture = await Effect.runPromise(makeFixture());
  publish(fixture.trace.requestListeners, createCall('call-timeout-fault', 'turn-current'));
  fixture.database.run('DROP TABLE scheduler_state');
  fixture.scheduled.runNext();

  expect(fixture.trace.responses).toHaveLength(1);
  expect(JSON.stringify(fixture.trace.responses[0]?.result)).toContain(
    'timed out before turn acceptance',
  );
  expect(fixture.errors).toHaveLength(1);
  expect(
    fixture.database
      .query<{ success: number }, []>(
        "SELECT success FROM schedule_tool_calls WHERE call_id = 'call-timeout-fault'",
      )
      .get(),
  ).toStrictEqual({ success: 0 });
  fixture.requests.close();
});

it('contains an executor fault while close cancels a pending request', async () => {
  const fixture = await Effect.runPromise(makeFixture());
  publish(fixture.trace.requestListeners, createCall('call-close-fault', 'turn-current'));
  fixture.database.run('DROP TABLE scheduler_state');

  expect(() => {
    fixture.requests.close();
  }).not.toThrow();
  fixture.scheduled.runNext();
  await Bun.sleep(0);

  expect(fixture.trace.responses).toHaveLength(1);
  expect(JSON.stringify(fixture.trace.responses[0]?.result)).toContain(
    'cancelled before turn acceptance',
  );
  expect(fixture.errors).toHaveLength(1);
  expect(
    fixture.database
      .query<{ success: number }, []>(
        "SELECT success FROM schedule_tool_calls WHERE call_id = 'call-close-fault'",
      )
      .get(),
  ).toStrictEqual({ success: 0 });
});
