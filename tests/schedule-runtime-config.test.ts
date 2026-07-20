import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { expect } from 'vitest';

import { makeCodexRuntime } from '../src/codex/runtime';
import { ScheduleCreate } from '../src/schedule/model';
import { makeHandle } from './codex-runtime-fixture';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) {
    throw new Error('expected object');
  }
  return value;
};

const array = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) {
    throw new TypeError('expected array');
  }
  return value;
};

it.effect('starts threads with versioned schedule tools and external current time', () =>
  Effect.gen(function* configuredThreadStart() {
    const fake = makeHandle();
    const runtime = makeCodexRuntime(fake.handle, 'prompt', 'default', '/workspace');
    expect(yield* runtime.startThread).toBe('thread');
    const request = fake.requests.find(({ method }) => method === 'thread/start');
    const params = record(request?.params);
    expect(params['config']).toEqual({
      'features.current_time_reminder.clock_source': 'external',
      'features.current_time_reminder.delivery_mode': 'after_user_or_tool_output',
      'features.current_time_reminder.enabled': true,
      'features.current_time_reminder.reminder_interval_seconds': 0,
    });
    const dynamicTools = array(params['dynamicTools']);
    expect(dynamicTools).toHaveLength(1);
    const namespace = record(dynamicTools[0]);
    expect(namespace).toMatchObject({
      description:
        'Manage durable reminders. Schedule IDs are internal: never quote or expose them to the user.',
      name: 'schedule',
      type: 'namespace',
    });
    const tools = array(namespace['tools']).map((tool) => record(tool));
    expect(tools.map((tool) => tool['name'])).toEqual([
      'create',
      'list',
      'update',
      'pause',
      'resume',
      'cancel',
    ]);
    const createTool = tools.find((tool) => tool['name'] === 'create');
    expect(createTool).toMatchObject({
      description:
        'Create a durable one-shot or recurring task. Clarify ambiguous dates before calling.',
      name: 'create',
      type: 'function',
    });
    const createSchema = record(createTool?.['inputSchema']);
    expect(createSchema).toMatchObject({
      additionalProperties: false,
      required: ['oneShotAt', 'prompt', 'timezone'],
      type: 'object',
    });
    const properties = record(createSchema['properties']);
    expect(Object.keys(properties).toSorted()).toEqual([
      'name',
      'oneShotAt',
      'prompt',
      'rrule',
      'timezone',
    ]);
    expect(record(properties['oneShotAt'])['type']).toBe('string');
    expect(record(properties['prompt'])['type']).toBe('string');
    expect(record(properties['timezone'])['type']).toBe('string');
    expect(record(properties['timezone'])['description']).toContain(
      "Use Spike's configured timezone unless the user explicitly specifies another",
    );
    const listTool = tools.find((tool) => tool['name'] === 'list');
    const listProperties = record(record(listTool?.['inputSchema'])['properties']);
    expect(record(listProperties['includeTerminal'])['description']).toBe(
      'Include completed and cancelled tasks. Defaults to false.',
    );
  }),
);

it('rejects invalid timezones at the schedule tool decode boundary', () => {
  expect(() =>
    Schema.decodeUnknownSync(ScheduleCreate)({
      oneShotAt: '2026-07-20T12:00:00Z',
      prompt: 'Run it',
      timezone: 'Europe/Not-A-City',
    }),
  ).toThrow('timezone');
});
