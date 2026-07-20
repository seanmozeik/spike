import { Schema } from 'effect';

import { IanaTimezone } from '../timezone';

class ScheduleError extends Schema.TaggedErrorClass<ScheduleError>()('ScheduleError', {
  cause: Schema.Defect(),
  message: Schema.String,
  operation: Schema.String,
}) {}

const ScheduleId = Schema.String.pipe(Schema.brand('ScheduleId'));
type ScheduleId = typeof ScheduleId.Type;

const ScheduleState = Schema.Literals(['Active', 'Paused', 'Completed', 'Cancelled']);
type ScheduleState = typeof ScheduleState.Type;

const InternalScheduleId = ScheduleId.annotate({
  description: 'Internal schedule ID. Never display this value to the user.',
});
const ScheduleName = Schema.String.annotate({ description: 'Optional human-readable task name.' });
const SchedulePrompt = Schema.String.annotate({
  description: 'The instruction Spike should execute when this task becomes due.',
});
const OneShotAt = Schema.String.annotate({
  description:
    'An anchored ISO 8601 timestamp including seconds and an explicit Z or numeric UTC offset.',
});
const RecurrenceRule = Schema.String.annotate({
  description:
    'Optional RFC 5545 RRULE anchored by oneShotAt as DTSTART; omit for a one-shot task.',
});
const Timezone = IanaTimezone;

const ScheduleCreate = Schema.Struct({
  name: Schema.optionalKey(ScheduleName),
  oneShotAt: OneShotAt,
  prompt: SchedulePrompt,
  rrule: Schema.optionalKey(RecurrenceRule),
  timezone: Timezone,
});
type ScheduleCreate = typeof ScheduleCreate.Type;

const ScheduleList = Schema.Struct({
  includeTerminal: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: 'Include completed and cancelled tasks. Defaults to false.',
    }),
  ),
});
type ScheduleList = typeof ScheduleList.Type;

const ScheduleUpdate = Schema.Struct({
  id: InternalScheduleId,
  name: Schema.optionalKey(Schema.NullOr(ScheduleName)),
  oneShotAt: Schema.optionalKey(OneShotAt),
  prompt: Schema.optionalKey(SchedulePrompt),
  rrule: Schema.optionalKey(Schema.NullOr(RecurrenceRule)),
  timezone: Schema.optionalKey(Timezone),
});
type ScheduleUpdate = typeof ScheduleUpdate.Type;

const ScheduleTarget = Schema.Struct({ id: InternalScheduleId });
type ScheduleTarget = typeof ScheduleTarget.Type;

const ScheduleToolCallParams = Schema.Struct({
  arguments: Schema.Unknown,
  callId: Schema.String,
  namespace: Schema.NullOr(Schema.String),
  threadId: Schema.String,
  tool: Schema.String,
  turnId: Schema.String,
});
type ScheduleToolCallParams = typeof ScheduleToolCallParams.Type;

const CurrentTimeReadParams = Schema.Struct({ threadId: Schema.String });

interface ScheduleRecord {
  readonly id: ScheduleId;
  readonly kind: 'OneShot' | 'Recurring';
  readonly name: null | string;
  readonly nextDueAt: null | Date;
  readonly oneShotAt: Date;
  readonly prompt: null | string;
  readonly rrule: null | string;
  readonly state: ScheduleState;
  readonly timezone: string;
}

interface ScheduleToolResult {
  readonly changed: boolean;
  readonly success: boolean;
  readonly text: string;
}

interface DueSchedule {
  readonly expectedDueAt: Date;
  readonly expectedRevision: number;
  readonly id: ScheduleId;
  readonly kind: 'OneShot' | 'Recurring';
  readonly oneShotAt: Date;
  readonly prompt: string;
  readonly rrule: null | string;
  readonly timezone: string;
}

export {
  ScheduleCreate,
  ScheduleError,
  ScheduleId,
  ScheduleList,
  ScheduleState,
  ScheduleTarget,
  ScheduleToolCallParams,
  ScheduleUpdate,
  CurrentTimeReadParams,
};
export type {
  DueSchedule,
  ScheduleCreate as ScheduleCreateInput,
  ScheduleList as ScheduleListInput,
  ScheduleRecord,
  ScheduleState as ScheduleStateValue,
  ScheduleTarget as ScheduleTargetInput,
  ScheduleToolResult,
  ScheduleToolCallParams as ScheduleToolCall,
  ScheduleUpdate as ScheduleUpdateInput,
};
