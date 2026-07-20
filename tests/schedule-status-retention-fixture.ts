import type { Database } from 'bun:sqlite';
import path from 'node:path';

import { Effect } from 'effect';

import type { OperatorCommandPort } from '../src/operator/commands';
import { spikePaths, type SpikePaths } from '../src/paths';
import { makeScheduleToolExecutor } from '../src/schedule/dynamic-tools';
import { makeScheduleJournal } from '../src/schedule/journal';
import { makeRetentionFixture, NOW, OLD, type RetentionFixture } from './retention-fixture';

const NEXT_DUE = '2026-07-16T12:00:00.000Z';
const LATER_DUE = '2026-07-17T12:00:00.000Z';
const ACTIVE_PROMPT_SECRET = 'active prompt alpine-violet';
const PAUSED_PROMPT_SECRET = 'paused prompt copper-lantern';
const COMPLETED_PROMPT_SECRET = 'completed prompt amber-marsh';
const CANCELLED_PROMPT_SECRET = 'cancelled prompt cobalt-orchid';
const TERMINAL_INBOUND_SECRET = 'terminal inbound silver-birch';
const NONTERMINAL_INBOUND_SECRET = 'nonterminal inbound topaz-river';
const TERMINAL_ERROR_SECRET = 'terminal error scarlet-comet';
const NONTERMINAL_ERROR_SECRET = 'nonterminal error indigo-fjord';
const RAW_TOOL_ARGUMENT_SECRET = 'raw argument golden-fern';
const OLD_TOOL_RESPONSE_SECRET = 'old response obsidian-lake';
const RECENT_TOOL_RESPONSE_SECRET = 'recent response jade-summit';

const STATUS_SECRETS = [
  ACTIVE_PROMPT_SECRET,
  PAUSED_PROMPT_SECRET,
  COMPLETED_PROMPT_SECRET,
  CANCELLED_PROMPT_SECRET,
  TERMINAL_INBOUND_SECRET,
  NONTERMINAL_INBOUND_SECRET,
  TERMINAL_ERROR_SECRET,
  NONTERMINAL_ERROR_SECRET,
  RAW_TOOL_ARGUMENT_SECRET,
  OLD_TOOL_RESPONSE_SECRET,
  RECENT_TOOL_RESPONSE_SECRET,
] as const;

const scheduleRows = [
  ['schedule-active-early', ACTIVE_PROMPT_SECRET, 'Active', NEXT_DUE],
  ['schedule-active-later', 'active prompt second', 'Active', LATER_DUE],
  ['schedule-paused', PAUSED_PROMPT_SECRET, 'Paused', null],
  ['schedule-completed', COMPLETED_PROMPT_SECRET, 'Completed', null],
  ['schedule-cancelled', CANCELLED_PROMPT_SECRET, 'Cancelled', null],
] as const;

const runRows = [
  [
    'run-completed',
    'schedule-completed',
    'Completed',
    'inbound-completed',
    TERMINAL_INBOUND_SECRET,
    TERMINAL_ERROR_SECRET,
    OLD.toISOString(),
  ],
  [
    'run-failed',
    'schedule-cancelled',
    'Failed',
    'inbound-failed',
    'terminal inbound second',
    'terminal error second',
    OLD.toISOString(),
  ],
  [
    'run-enqueued',
    'schedule-active-early',
    'Enqueued',
    'inbound-enqueued',
    NONTERMINAL_INBOUND_SECRET,
    null,
    null,
  ],
  [
    'run-running',
    'schedule-active-later',
    'Running',
    'inbound-running',
    'nonterminal inbound second',
    NONTERMINAL_ERROR_SECRET,
    null,
  ],
] as const;

interface ScheduleStatusRetentionFixture extends RetentionFixture {
  readonly paths: SpikePaths;
}

const insertSchedules = (database: Database): void => {
  for (const [id, prompt, state, nextDueAt] of scheduleRows) {
    database.run(
      `INSERT INTO schedules(
         id, name, prompt, kind, one_shot_at, rrule, timezone, state,
         next_due_at, created_at, updated_at
       ) VALUES (?, NULL, ?, 'OneShot', ?, NULL, 'Europe/London', ?, ?, ?, ?)`,
      [id, prompt, NEXT_DUE, state, nextDueAt, OLD.toISOString(), OLD.toISOString()],
    );
  }
};

const insertRuns = (database: Database): void => {
  for (const [id, scheduleId, state, inboundId, text, error, completedAt] of runRows) {
    database.run(
      `INSERT INTO inbound_messages(
         id, source_kind, source_id, message_guid, messages_rowid, chat_guid, handle,
         service, text, sent_at, observed_at
       ) VALUES (?, 'ScheduleRun', ?, NULL, NULL, 'schedule', 'schedule',
                 'Schedule', ?, ?, ?)`,
      [inboundId, id, text, OLD.toISOString(), OLD.toISOString()],
    );
    database.run(
      `INSERT INTO scheduled_runs(
         id, schedule_id, scheduled_for, state, inbound_message_id, logical_turn_id,
         enqueued_at, started_at, completed_at, error
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [
        id,
        scheduleId,
        OLD.toISOString(),
        state,
        inboundId,
        OLD.toISOString(),
        state === 'Enqueued' ? null : OLD.toISOString(),
        completedAt,
        error,
      ],
    );
  }
};

const insertToolCalls = (database: Database): void => {
  const execute = makeScheduleToolExecutor(database, makeScheduleJournal(database), () => {
    // Mutation observation is outside this fixture's status and retention contract.
  });
  execute(
    {
      arguments: {
        oneShotAt: NEXT_DUE,
        prompt: RAW_TOOL_ARGUMENT_SECRET,
        timezone: 'Europe/London',
      },
      callId: 'call-old',
      namespace: 'schedule',
      threadId: 'inactive-thread',
      tool: 'create',
      turnId: 'inactive-turn',
    },
    OLD,
  );
  execute(
    {
      arguments: {},
      callId: 'call-recent',
      namespace: 'schedule',
      threadId: 'inactive-thread',
      tool: 'list',
      turnId: 'inactive-turn',
    },
    NOW,
  );
  database.run('UPDATE schedule_tool_calls SET response_json = ? WHERE call_id = ?', [
    JSON.stringify({ secret: OLD_TOOL_RESPONSE_SECRET }),
    'call-old',
  ]);
  database.run('UPDATE schedule_tool_calls SET response_json = ? WHERE call_id = ?', [
    JSON.stringify({ secret: RECENT_TOOL_RESPONSE_SECRET }),
    'call-recent',
  ]);
};

const databasePath = (database: Database): string => {
  const row = database
    .query<{ file: string }, []>("SELECT file FROM pragma_database_list WHERE name = 'main'")
    .get();
  if (row === null) {
    throw new Error('expected the retention journal path');
  }
  return row.file;
};

const makeScheduleStatusRetentionFixture = Effect.fn('Test.makeScheduleStatusRetentionFixture')(
  function* makeFixture() {
    const fixture = yield* makeRetentionFixture();
    insertSchedules(fixture.database);
    insertRuns(fixture.database);
    insertToolCalls(fixture.database);
    const database = databasePath(fixture.database);
    const root = path.dirname(database);
    return {
      ...fixture,
      paths: { ...spikePaths(root), database, launchAgent: path.join(root, 'launch-agent.plist') },
    } satisfies ScheduleStatusRetentionFixture;
  },
);

const successfulCommands: OperatorCommandPort = {
  accessibilityStatus: () =>
    Effect.succeed({
      exitCode: 0,
      signalCode: null,
      stderr: '',
      stdout: '{"accessibilityTrusted":true,"locked":false}',
      timedOut: false,
    }),
  launchctl: () =>
    Effect.succeed({ exitCode: 0, signalCode: null, stderr: '', stdout: '', timedOut: false }),
  messagesAutomation: Effect.succeed({
    exitCode: 0,
    signalCode: null,
    stderr: '',
    stdout: 'Messages',
    timedOut: false,
  }),
};

export {
  makeScheduleStatusRetentionFixture,
  NEXT_DUE,
  RAW_TOOL_ARGUMENT_SECRET,
  RECENT_TOOL_RESPONSE_SECRET,
  STATUS_SECRETS,
  successfulCommands,
};
export type { ScheduleStatusRetentionFixture };
