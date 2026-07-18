import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import type { Frontier } from '../codex/reconcile';
import {
  CodexAttemptId,
  InputBatchId,
  type AccountId,
  type CodexItemId,
  type CodexThreadId,
  type CodexTurnId,
  type LogicalTurnId,
} from '../domain/ids';
import { JournalTransactionError } from '../errors';
import {
  makeGenerationThreadJournal,
  type GenerationThreadJournal,
} from './generation-thread-journal';

interface BeginCodexAttempt {
  readonly accountId: AccountId;
  readonly batchId: InputBatchId;
  readonly fingerprint: string;
  readonly frontier: Frontier;
  readonly logicalTurnId: LogicalTurnId;
  readonly startedAt: Date;
  readonly submissionKind: 'Start' | 'Steer';
}

interface CodexAttemptRecord {
  readonly batchId: InputBatchId | null;
  readonly frontier: Frontier;
  readonly id: CodexAttemptId;
  readonly logicalTurnId: string;
  readonly state: string;
  readonly submissionKind: 'Start' | 'Steer';
  readonly threadId: string | null;
  readonly turnId: string | null;
}

interface AttemptRow {
  readonly codex_thread_id: string | null;
  readonly codex_turn_id: string | null;
  readonly frontier_json: string;
  readonly id: string;
  readonly input_batch_id: string | null;
  readonly input_fingerprint: string;
  readonly logical_turn_id: string;
  readonly state: string;
  readonly submission_kind: 'Start' | 'Steer';
}

interface CodexJournal extends GenerationThreadJournal {
  readonly acceptCodexTurn: (
    attemptId: CodexAttemptId,
    threadId: CodexThreadId,
    turnId: CodexTurnId,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly beginCodexAttempt: (
    input: BeginCodexAttempt,
  ) => Effect.Effect<CodexAttemptId, JournalTransactionError>;
  readonly loadNonterminalAttempts: Effect.Effect<readonly CodexAttemptRecord[]>;
  readonly finishLogicalTurn: (
    logicalTurnId: LogicalTurnId,
    outcome: 'Completed' | 'Failed',
    finishedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly recordAgentItem: (
    attemptId: CodexAttemptId,
    itemId: CodexItemId,
    kind: string,
    payload: unknown,
    observedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly recordAccountObservation: (
    accountId: AccountId,
    usable: boolean,
    usage: unknown,
    resetAt: Date | null,
    observedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly recordSubmissionUnknown: (
    attemptId: CodexAttemptId,
  ) => Effect.Effect<void, JournalTransactionError>;
}

const journalError = (transaction: string, cause: unknown): JournalTransactionError =>
  new JournalTransactionError({ cause, message: `${transaction} failed`, transaction });

const changedOne = (changes: number, operation: string): void => {
  if (changes !== 1) {
    throw new Error(`${operation} expected one row, changed ${String(changes)}`);
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const stringArray = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;

const parseFrontier = (json: string): Frontier => {
  const value: unknown = JSON.parse(json);
  const itemIds = isObject(value) ? stringArray(value['itemIds']) : null;
  const turnIds = isObject(value) ? stringArray(value['turnIds']) : null;
  if (itemIds === null || turnIds === null) {
    throw new Error('stored Codex frontier is invalid');
  }
  return { itemIds, turnIds };
};

const parseAttempt = (row: AttemptRow): CodexAttemptRecord => ({
  batchId: row.input_batch_id === null ? null : InputBatchId.make(row.input_batch_id),
  frontier: parseFrontier(row.frontier_json),
  id: CodexAttemptId.make(row.id),
  logicalTurnId: row.logical_turn_id,
  state: row.state,
  submissionKind: row.submission_kind,
  threadId: row.codex_thread_id,
  turnId: row.codex_turn_id,
});

const makeAcceptTurn =
  (database: Database): CodexJournal['acceptCodexTurn'] =>
  (attemptId, threadId, turnId) =>
    Effect.try({
      catch: (cause) => journalError('acceptCodexTurn', cause),
      try: () => {
        const result = database.run(
          `UPDATE codex_attempts SET state = 'Accepted', codex_thread_id = ?,
             codex_turn_id = CASE WHEN submission_kind = 'Steer' THEN NULL ELSE ? END
         WHERE id = ? AND state IN ('Prepared','Submitted','SubmissionUnknown')`,
          [threadId, turnId, attemptId],
        );
        changedOne(result.changes, 'acceptCodexTurn');
      },
    });

const makeBeginAttempt =
  (database: Database): CodexJournal['beginCodexAttempt'] =>
  (input) =>
    Effect.try({
      catch: (cause) => journalError('beginCodexAttempt', cause),
      try: () => {
        const id = CodexAttemptId.make(randomUUID());
        database.run(
          `INSERT INTO codex_attempts(
          id, logical_turn_id, input_batch_id, account_id, state, input_fingerprint,
          frontier_json, submission_kind, started_at
        ) VALUES (?, ?, ?, ?, 'Prepared', ?, ?, ?, ?)`,
          [
            id,
            input.logicalTurnId,
            input.batchId,
            input.accountId,
            input.fingerprint,
            JSON.stringify(input.frontier),
            input.submissionKind,
            input.startedAt.toISOString(),
          ],
        );
        return id;
      },
    });

const makeRecordItem =
  (database: Database): CodexJournal['recordAgentItem'] =>
  (attemptId, itemId, kind, payload, observedAt) =>
    Effect.try({
      catch: (cause) => journalError('recordAgentItem', cause),
      try: () => {
        database.run(
          `INSERT OR IGNORE INTO codex_agent_items(
          id, codex_attempt_id, codex_item_id, kind, payload_json, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            attemptId,
            itemId,
            kind,
            JSON.stringify(payload),
            observedAt.toISOString(),
          ],
        );
      },
    });

const makeFinishLogicalTurn =
  (database: Database): CodexJournal['finishLogicalTurn'] =>
  (logicalTurnId, outcome, finishedAt) =>
    Effect.try({
      catch: (cause) => journalError('finishLogicalTurn', cause),
      try: () => {
        database.run(
          `UPDATE codex_attempts SET state = ?, finished_at = ?
           WHERE logical_turn_id = ? AND state = 'Accepted'`,
          [outcome, finishedAt.toISOString(), logicalTurnId],
        );
      },
    });

const makeRecordAccountObservation =
  (database: Database): CodexJournal['recordAccountObservation'] =>
  (accountId, usable, usage, resetAt, observedAt) =>
    Effect.try({
      catch: (cause) => journalError('recordAccountObservation', cause),
      try: () => {
        database.run(
          `INSERT INTO account_observations(account_id, observed_at, usable, usage_json, reset_at)
         VALUES (?, ?, ?, ?, ?)`,
          [
            accountId,
            observedAt.toISOString(),
            usable ? 1 : 0,
            JSON.stringify(usage),
            resetAt?.toISOString() ?? null,
          ],
        );
      },
    });

const makeUnknown =
  (database: Database): CodexJournal['recordSubmissionUnknown'] =>
  (attemptId) =>
    Effect.try({
      catch: (cause) => journalError('recordSubmissionUnknown', cause),
      try: () => {
        const result = database.run(
          `UPDATE codex_attempts SET state = 'SubmissionUnknown'
         WHERE id = ? AND state IN ('Prepared','Submitted')`,
          [attemptId],
        );
        changedOne(result.changes, 'recordSubmissionUnknown');
      },
    });

const makeCodexJournal = (database: Database): CodexJournal => ({
  ...makeGenerationThreadJournal(database),
  acceptCodexTurn: makeAcceptTurn(database),
  beginCodexAttempt: makeBeginAttempt(database),
  finishLogicalTurn: makeFinishLogicalTurn(database),
  loadNonterminalAttempts: Effect.sync(() =>
    database
      .query<AttemptRow, []>(
        `SELECT id, logical_turn_id, input_batch_id, state, input_fingerprint, frontier_json,
                submission_kind, codex_thread_id, codex_turn_id
       FROM codex_attempts WHERE state IN ('Prepared','Submitted','SubmissionUnknown','Accepted')
       ORDER BY started_at ASC`,
      )
      .all()
      .map((row) => parseAttempt(row)),
  ),
  recordAccountObservation: makeRecordAccountObservation(database),
  recordAgentItem: makeRecordItem(database),
  recordSubmissionUnknown: makeUnknown(database),
});

export { makeCodexJournal };
export type { BeginCodexAttempt, CodexAttemptRecord, CodexJournal };
