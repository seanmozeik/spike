import type { Schema } from 'effect';
import * as Tool from 'effect/unstable/ai/Tool';

import { ScheduleCreate, ScheduleList, ScheduleTarget, ScheduleUpdate } from './model';

interface FunctionTool<S extends Schema.Constraint> extends Record<string, unknown> {
  readonly inputSchema: ReturnType<typeof Tool.getJsonSchemaFromSchema<S>>;
}

const functionTool = <S extends Schema.Constraint>(
  name: string,
  description: string,
  schema: S,
): FunctionTool<S> => ({
  deferLoading: false,
  description,
  inputSchema: Tool.getJsonSchemaFromSchema(schema),
  name,
  type: 'function',
});

const scheduleDynamicTools = [
  {
    description:
      'Manage durable reminders. Schedule IDs are internal: never quote or expose them to the user.',
    name: 'schedule',
    tools: [
      functionTool(
        'create',
        'Create a durable one-shot or recurring task. Clarify ambiguous dates before calling.',
        ScheduleCreate,
      ),
      functionTool(
        'list',
        'List durable tasks. Never expose returned IDs to the user.',
        ScheduleList,
      ),
      functionTool('update', 'Update a durable task using its internal ID.', ScheduleUpdate),
      functionTool('pause', 'Pause an active durable task using its internal ID.', ScheduleTarget),
      functionTool('resume', 'Resume a paused durable task using its internal ID.', ScheduleTarget),
      functionTool('cancel', 'Cancel a durable task using its internal ID.', ScheduleTarget),
    ],
    type: 'namespace',
  },
] as const;

export { scheduleDynamicTools };
