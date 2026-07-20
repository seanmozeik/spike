import { Effect, Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';

import { CodexTurnId } from '../src/domain/ids';
import { makeScheduleToolExecutor } from '../src/schedule/dynamic-tools';
import { makeScheduleJournal } from '../src/schedule/journal';
import {
  ScheduleId,
  ScheduleState,
  type ScheduleToolCall,
  type ScheduleToolResult,
} from '../src/schedule/model';
import { cleanupFixtures, makeFixture, NOW } from './schedule-server-requests-fixture';

afterEach(() => {
  cleanupFixtures();
});

const call = (callId: string, tool: string, args: unknown): ScheduleToolCall => ({
  arguments: args,
  callId,
  namespace: 'schedule',
  threadId: 'thread-current',
  tool,
  turnId: 'turn-current',
});

const resultValue = (result: ScheduleToolResult): unknown => {
  const parsed: unknown = JSON.parse(result.text);
  return parsed;
};

const ScheduleView = Schema.Struct({
  id: ScheduleId,
  prompt: Schema.NullOr(Schema.String),
  state: ScheduleState,
});

type ScheduleView = typeof ScheduleView.Type;
type ScheduleExecutor = ReturnType<typeof makeScheduleToolExecutor>;

const decodeSchedule = Schema.decodeUnknownSync(ScheduleView);
const decodeSchedules = Schema.decodeUnknownSync(Schema.Array(ScheduleView));

const executeSchedule = (
  execute: ScheduleExecutor,
  callId: string,
  tool: string,
  arguments_: unknown,
): ScheduleView => {
  const result = execute(call(callId, tool, arguments_), NOW);
  return decodeSchedule(resultValue(result));
};

const listSchedules = (
  execute: ScheduleExecutor,
  callId: string,
  includeTerminal = false,
): readonly ScheduleView[] => {
  const result = execute(call(callId, 'list', { includeTerminal }), NOW);
  return decodeSchedules(resultValue(result));
};

test('dynamic tools list, pause, resume, and cancel without dispatching inactive schedules', async () => {
  const fixture = await Effect.runPromise(makeFixture());
  await Effect.runPromise(
    fixture.codex.acceptCodexTurn(
      fixture.attemptId,
      fixture.threadId,
      CodexTurnId.make('turn-current'),
    ),
  );
  const journal = makeScheduleJournal(fixture.database);
  let mutations = 0;
  const execute = makeScheduleToolExecutor(fixture.database, journal, () => {
    mutations += 1;
  });
  const created = executeSchedule(execute, 'lifecycle-create', 'create', {
    name: 'Lifecycle task',
    oneShotAt: '2026-07-19T11:59:00Z',
    prompt: 'Run lifecycle task',
    timezone: 'UTC',
  });
  expect(created.state).toBe('Active');
  const scheduleId = created.id;
  expect(scheduleId).toBeTypeOf('string');

  const updated = executeSchedule(execute, 'lifecycle-update', 'update', {
    id: scheduleId,
    prompt: 'Run updated lifecycle task',
  });
  expect(updated.prompt).toBe('Run updated lifecycle task');

  const listed = listSchedules(execute, 'lifecycle-list-active');
  expect(listed).toContainEqual(expect.objectContaining({ id: scheduleId, state: 'Active' }));

  const paused = executeSchedule(execute, 'lifecycle-pause', 'pause', { id: scheduleId });
  expect(paused.state).toBe('Paused');
  expect(await Effect.runPromise(journal.due(NOW))).toBeNull();

  const resumed = executeSchedule(execute, 'lifecycle-resume', 'resume', { id: scheduleId });
  expect(resumed.state).toBe('Active');
  const resumedDue = await Effect.runPromise(journal.due(NOW));
  expect(resumedDue?.id).toBe(scheduleId);

  const cancelled = executeSchedule(execute, 'lifecycle-cancel', 'cancel', { id: scheduleId });
  expect(cancelled.state).toBe('Cancelled');
  expect(await Effect.runPromise(journal.due(NOW))).toBeNull();
  const terminal = listSchedules(execute, 'lifecycle-list-terminal', true);
  expect(terminal).toContainEqual(expect.objectContaining({ id: scheduleId, state: 'Cancelled' }));
  expect(mutations).toBe(5);
  fixture.requests.close();
});
