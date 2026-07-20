import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

import { Schema } from 'effect';

import type { ScheduleToolCall, ScheduleToolResult } from './model';

interface ToolCallRow {
  readonly request_hash: string;
  readonly response_json: null | string;
}

const StoredScheduleToolResult = Schema.Struct({
  changed: Schema.Boolean,
  success: Schema.Boolean,
  text: Schema.String,
});
const StoredScheduleToolResultJson = Schema.fromJsonString(StoredScheduleToolResult);

const canonical = (value: unknown): string => {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((child) => canonical(child)).join(',')}]`;
  }
  const entries = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
};

const requestHash = (call: ScheduleToolCall): string =>
  createHash('sha256')
    .update(
      `${call.threadId}\0${call.turnId}\0${call.callId}\0${call.namespace ?? ''}\0${call.tool}\0${canonical(call.arguments)}`,
    )
    .digest('hex');

const scheduleToolResult = (
  success: boolean,
  value: unknown,
  changed = false,
): ScheduleToolResult => ({
  changed,
  success,
  text: typeof value === 'string' ? value : JSON.stringify(value),
});

const rejectScheduleToolCallDrift = (
  database: Database,
  call: ScheduleToolCall,
): null | ScheduleToolResult => {
  const hash = requestHash(call);
  const prior = database
    .query<{ readonly request_hash: string }, [string]>(
      'SELECT request_hash FROM schedule_tool_calls WHERE call_id = ?',
    )
    .get(call.callId);
  if (prior === null || prior.request_hash === hash) {
    return null;
  }
  return scheduleToolResult(false, 'tool call ID was reused with different arguments');
};

const storedScheduleToolResponse = (
  database: Database,
  call: ScheduleToolCall,
): null | ScheduleToolResult => {
  const prior = database
    .query<ToolCallRow, [string]>(
      'SELECT request_hash, response_json FROM schedule_tool_calls WHERE call_id = ?',
    )
    .get(call.callId);
  if (prior === null) {
    return null;
  }
  if (prior.request_hash !== requestHash(call)) {
    return scheduleToolResult(false, 'tool call ID was reused with different arguments');
  }
  if (prior.response_json === null) {
    return scheduleToolResult(false, 'tool call result has expired');
  }
  try {
    return Schema.decodeUnknownSync(StoredScheduleToolResultJson)(prior.response_json);
  } catch {
    return scheduleToolResult(false, 'stored schedule tool response was invalid');
  }
};

const persistScheduleToolFailure = (
  database: Database,
  call: ScheduleToolCall,
  now: Date,
  message: string,
): ScheduleToolResult => {
  const transaction = database.transaction(() => {
    const prior = storedScheduleToolResponse(database, call);
    if (prior !== null) {
      return prior;
    }
    const response = scheduleToolResult(false, message);
    database.run(
      `INSERT INTO schedule_tool_calls(call_id, request_hash, response_json, success, created_at)
       VALUES (?, ?, ?, 0, ?)`,
      [call.callId, requestHash(call), JSON.stringify(response), now.toISOString()],
    );
    return response;
  });
  return transaction();
};

const persistScheduleToolGateFailure = (
  database: Database,
  call: ScheduleToolCall,
  now: Date,
  message: string,
): ScheduleToolResult => {
  const drift = rejectScheduleToolCallDrift(database, call);
  if (drift !== null) {
    return drift;
  }
  const response = scheduleToolResult(false, message);
  database.run(
    `INSERT OR IGNORE INTO schedule_tool_calls(
       call_id, request_hash, response_json, success, created_at
     ) VALUES (?, ?, ?, 0, ?)`,
    [call.callId, requestHash(call), JSON.stringify(response), now.toISOString()],
  );
  return response;
};

export {
  persistScheduleToolFailure,
  persistScheduleToolGateFailure,
  rejectScheduleToolCallDrift,
  requestHash,
  scheduleToolResult,
  storedScheduleToolResponse,
};
