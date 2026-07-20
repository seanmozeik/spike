import type { Database } from 'bun:sqlite';

import { Effect, Schema } from 'effect';

import type { ScheduleJournal } from './journal';
import {
  ScheduleCreate,
  ScheduleList,
  ScheduleTarget,
  ScheduleUpdate,
  type ScheduleRecord,
  type ScheduleToolCall,
  type ScheduleToolResult,
} from './model';
import { formatLocal } from './recurrence';
import { authorizeScheduleToolCall } from './tool-authorization';
import {
  rejectScheduleToolCallDrift,
  requestHash,
  scheduleToolResult as result,
  storedScheduleToolResponse as storedResponse,
} from './tool-call-store';

const recordView = (record: ScheduleRecord): Record<string, unknown> => ({
  id: record.id,
  kind: record.kind,
  name: record.name,
  nextDueAt: record.nextDueAt?.toISOString() ?? null,
  nextDueLocal: record.nextDueAt === null ? null : formatLocal(record.nextDueAt, record.timezone),
  oneShotAt: record.oneShotAt.toISOString(),
  prompt: record.prompt,
  rrule: record.rrule,
  state: record.state,
  timezone: record.timezone,
});

const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown): A =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value);

const dispatchTool = (
  journal: ScheduleJournal,
  call: ScheduleToolCall,
  now: Date,
): Effect.Effect<ScheduleToolResult, unknown> => {
  if (call.namespace !== 'schedule') {
    return Effect.succeed(result(false, 'unknown dynamic tool namespace'));
  }
  if (call.tool === 'create') {
    return journal
      .create(decode(ScheduleCreate, call.arguments), now)
      .pipe(Effect.map((record) => result(true, recordView(record), true)));
  }
  if (call.tool === 'list') {
    const input = decode(ScheduleList, call.arguments);
    return journal.list(input.includeTerminal ?? false).pipe(
      Effect.map((records) =>
        result(
          true,
          records.map((record) => recordView(record)),
        ),
      ),
    );
  }
  if (call.tool === 'update') {
    return journal
      .update(decode(ScheduleUpdate, call.arguments), now)
      .pipe(Effect.map((record) => result(true, recordView(record), true)));
  }
  if (call.tool === 'pause' || call.tool === 'resume' || call.tool === 'cancel') {
    const input = decode(ScheduleTarget, call.arguments);
    return journal[call.tool](input.id, now).pipe(
      Effect.map((record) => result(true, recordView(record), true)),
    );
  }
  return Effect.succeed(result(false, `unknown schedule tool ${call.tool}`));
};

const persistResponse = (
  database: Database,
  call: ScheduleToolCall,
  response: ScheduleToolResult,
  now: Date,
): ScheduleToolResult => {
  database.run(
    `INSERT INTO schedule_tool_calls(call_id, request_hash, response_json, success, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      call.callId,
      requestHash(call),
      JSON.stringify(response),
      response.success ? 1 : 0,
      now.toISOString(),
    ],
  );
  return response;
};

const executeScheduleToolCall = (
  database: Database,
  journal: ScheduleJournal,
  call: ScheduleToolCall,
  now: Date,
  pendingFailure?: string,
): ScheduleToolResult => {
  const drift = rejectScheduleToolCallDrift(database, call);
  if (drift !== null) {
    return drift;
  }
  const authorization = authorizeScheduleToolCall(database, call);
  if (authorization.kind !== 'Authorized') {
    const message =
      authorization.kind === 'Rejected'
        ? authorization.message
        : (pendingFailure ?? 'schedule tool call was not bound to an accepted turn');
    const response = result(false, message);
    database.run(
      `INSERT OR IGNORE INTO schedule_tool_calls(
         call_id, request_hash, response_json, success, created_at
       ) VALUES (?, ?, ?, 0, ?)`,
      [call.callId, requestHash(call), JSON.stringify(response), now.toISOString()],
    );
    return response;
  }
  const prior = storedResponse(database, call);
  if (prior !== null) {
    return prior;
  }
  try {
    return persistResponse(database, call, Effect.runSync(dispatchTool(journal, call, now)), now);
  } catch (error) {
    return persistResponse(
      database,
      call,
      result(false, error instanceof Error ? error.message : String(error)),
      now,
    );
  }
};

const makeScheduleToolExecutor = (
  database: Database,
  journal: ScheduleJournal,
  onChanged: () => void,
) => {
  const transaction = database.transaction(
    (call: ScheduleToolCall, now: Date, pendingFailure?: string) =>
      executeScheduleToolCall(database, journal, call, now, pendingFailure),
  );
  return (call: ScheduleToolCall, now: Date, pendingFailure?: string): ScheduleToolResult => {
    const response = transaction(call, now, pendingFailure);
    if (response.changed) {
      onChanged();
    }
    return response;
  };
};

export { makeScheduleToolExecutor };
