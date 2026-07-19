import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { makeCodexRuntime } from '../src/codex/runtime';
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
    expect(namespace).toMatchObject({ name: 'schedule', type: 'namespace' });
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
    expect(createTool).toMatchObject({ name: 'create', type: 'function' });
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
  }),
);
