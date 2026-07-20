import type { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { CUTOFF, NOW, OLD } from './retention-fixture';
import {
  makeScheduleStatusRetentionFixture,
  RECENT_TOOL_RESPONSE_SECRET,
} from './schedule-status-retention-fixture';

interface SchedulePayloadRow {
  readonly created_at: string;
  readonly id: string;
  readonly payload_redacted_at: null | string;
  readonly prompt: null | string;
  readonly state: string;
  readonly updated_at: string;
}

interface RunPayloadRow {
  readonly completed_at: null | string;
  readonly enqueued_at: string;
  readonly error: null | string;
  readonly id: string;
  readonly payload_redacted_at: null | string;
  readonly scheduled_for: string;
  readonly state: string;
}

interface InboundPayloadRow {
  readonly id: string;
  readonly observed_at: string;
  readonly payload_redacted_at: null | string;
  readonly sent_at: string;
  readonly source_id: string;
  readonly source_kind: string;
  readonly text: null | string;
}

interface ToolCallPayloadRow {
  readonly call_id: string;
  readonly created_at: string;
  readonly payload_redacted_at: null | string;
  readonly request_hash: string;
  readonly response_json: null | string;
  readonly success: number;
}

const scheduleRows = (database: Database): readonly SchedulePayloadRow[] =>
  database
    .query<SchedulePayloadRow, []>(
      `SELECT id, prompt, state, created_at, updated_at, payload_redacted_at
       FROM schedules ORDER BY id`,
    )
    .all();

const runRows = (database: Database): readonly RunPayloadRow[] =>
  database
    .query<RunPayloadRow, []>(
      `SELECT id, state, scheduled_for, enqueued_at, completed_at, error,
              payload_redacted_at FROM scheduled_runs ORDER BY id`,
    )
    .all();

it.effect('redacts terminal schedule payloads after thirty days but preserves audit state', () =>
  Effect.gen(function* scheduleRetentionMatrix() {
    const fixture = yield* makeScheduleStatusRetentionFixture();
    try {
      expect(yield* fixture.journal.redactTerminalPayloads(CUTOFF, NOW)).toBe(2);
      expect(scheduleRows(fixture.database)).toStrictEqual([
        {
          created_at: OLD.toISOString(),
          id: 'schedule-active-early',
          payload_redacted_at: null,
          prompt: 'active prompt alpine-violet',
          state: 'Active',
          updated_at: OLD.toISOString(),
        },
        {
          created_at: OLD.toISOString(),
          id: 'schedule-active-later',
          payload_redacted_at: null,
          prompt: 'active prompt second',
          state: 'Active',
          updated_at: OLD.toISOString(),
        },
        {
          created_at: OLD.toISOString(),
          id: 'schedule-cancelled',
          payload_redacted_at: NOW.toISOString(),
          prompt: null,
          state: 'Cancelled',
          updated_at: OLD.toISOString(),
        },
        {
          created_at: OLD.toISOString(),
          id: 'schedule-completed',
          payload_redacted_at: NOW.toISOString(),
          prompt: null,
          state: 'Completed',
          updated_at: OLD.toISOString(),
        },
        {
          created_at: OLD.toISOString(),
          id: 'schedule-paused',
          payload_redacted_at: null,
          prompt: 'paused prompt copper-lantern',
          state: 'Paused',
          updated_at: OLD.toISOString(),
        },
      ]);

      expect(runRows(fixture.database)).toStrictEqual([
        {
          completed_at: OLD.toISOString(),
          enqueued_at: OLD.toISOString(),
          error: null,
          id: 'run-completed',
          payload_redacted_at: NOW.toISOString(),
          scheduled_for: OLD.toISOString(),
          state: 'Completed',
        },
        {
          completed_at: null,
          enqueued_at: OLD.toISOString(),
          error: null,
          id: 'run-enqueued',
          payload_redacted_at: null,
          scheduled_for: OLD.toISOString(),
          state: 'Enqueued',
        },
        {
          completed_at: OLD.toISOString(),
          enqueued_at: OLD.toISOString(),
          error: null,
          id: 'run-failed',
          payload_redacted_at: NOW.toISOString(),
          scheduled_for: OLD.toISOString(),
          state: 'Failed',
        },
        {
          completed_at: null,
          enqueued_at: OLD.toISOString(),
          error: 'nonterminal error indigo-fjord',
          id: 'run-running',
          payload_redacted_at: null,
          scheduled_for: OLD.toISOString(),
          state: 'Running',
        },
      ]);

      const inbound = fixture.database
        .query<InboundPayloadRow, []>(
          `SELECT id, source_kind, source_id, text, sent_at, observed_at, payload_redacted_at
           FROM inbound_messages WHERE source_kind = 'ScheduleRun' ORDER BY id`,
        )
        .all();
      expect(inbound).toMatchObject([
        { id: 'inbound-completed', payload_redacted_at: NOW.toISOString(), text: null },
        {
          id: 'inbound-enqueued',
          payload_redacted_at: null,
          text: 'nonterminal inbound topaz-river',
        },
        { id: 'inbound-failed', payload_redacted_at: NOW.toISOString(), text: null },
        { id: 'inbound-running', payload_redacted_at: null, text: 'nonterminal inbound second' },
      ]);
      for (const row of inbound) {
        expect(row.source_kind).toBe('ScheduleRun');
        expect(row.source_id).toBe(row.id.replace('inbound-', 'run-'));
        expect(row.sent_at).toBe(OLD.toISOString());
        expect(row.observed_at).toBe(OLD.toISOString());
      }

      const toolCalls = fixture.database
        .query<ToolCallPayloadRow, []>(
          `SELECT call_id, request_hash, response_json, success, created_at,
                  payload_redacted_at FROM schedule_tool_calls ORDER BY call_id`,
        )
        .all();
      expect(toolCalls).toMatchObject([
        {
          call_id: 'call-old',
          created_at: OLD.toISOString(),
          payload_redacted_at: NOW.toISOString(),
          response_json: null,
          success: 0,
        },
        {
          call_id: 'call-recent',
          created_at: NOW.toISOString(),
          payload_redacted_at: null,
          response_json: JSON.stringify({ secret: RECENT_TOOL_RESPONSE_SECRET }),
          success: 0,
        },
      ]);
      for (const { request_hash: requestHash } of toolCalls) {
        expect(requestHash).toMatch(/^[a-f\d]{64}$/u);
      }
    } finally {
      fixture.close();
    }
  }),
);
