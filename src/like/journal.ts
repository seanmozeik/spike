import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import type { InboundMessageId } from '../domain/ids';
import { JournalTransactionError } from '../errors';

interface LikeStatus {
  readonly available: boolean;
  readonly degraded: boolean;
  readonly lastFailureAt: Date | null;
  readonly lastFailureReason: string | null;
  readonly lastSuccessAt: Date | null;
}

interface LikeStatusRow {
  readonly available: number;
  readonly degraded: number;
  readonly last_failure_at: null | string;
  readonly last_failure_reason: null | string;
  readonly last_success_at: null | string;
}

interface LikeJournal {
  readonly beginOnce: (
    inboundMessageId: InboundMessageId,
    startedAt: Date,
  ) => Effect.Effect<string | null, JournalTransactionError>;
  readonly finish: (
    attemptId: string,
    outcome: 'Failed' | 'Succeeded',
    reason: string | null,
    finishedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly status: Effect.Effect<LikeStatus, JournalTransactionError>;
}

const journalError = (transaction: string, cause: unknown): JournalTransactionError =>
  new JournalTransactionError({
    cause,
    message: `Like journal transaction failed: ${transaction}`,
    transaction,
  });

const emptyStatus = (): LikeStatus => ({
  available: false,
  degraded: false,
  lastFailureAt: null,
  lastFailureReason: null,
  lastSuccessAt: null,
});

const readStatus = (database: Database): LikeStatus => {
  const row = database
    .query<LikeStatusRow, []>(
      `SELECT available, degraded, last_success_at, last_failure_at, last_failure_reason
       FROM like_status WHERE singleton = 1`,
    )
    .get();
  return row === null
    ? emptyStatus()
    : {
        available: row.available === 1,
        degraded: row.degraded === 1,
        lastFailureAt: row.last_failure_at === null ? null : new Date(row.last_failure_at),
        lastFailureReason: row.last_failure_reason,
        lastSuccessAt: row.last_success_at === null ? null : new Date(row.last_success_at),
      };
};

const makeBeginOnce = (database: Database): LikeJournal['beginOnce'] => {
  const transaction = database.transaction(
    (inboundMessageId: InboundMessageId, startedAt: string): string | null => {
      const exists = database
        .query<{ present: number }, [string]>(
          'SELECT 1 AS present FROM like_attempts WHERE inbound_message_id = ? LIMIT 1',
        )
        .get(inboundMessageId);
      if (exists !== null) {
        return null;
      }
      const attemptId = randomUUID();
      database.run(
        `INSERT INTO like_attempts(
           id, inbound_message_id, attempt_number, state, started_at
         ) VALUES (?, ?, 1, 'Started', ?)`,
        [attemptId, inboundMessageId, startedAt],
      );
      return attemptId;
    },
  );
  return (inboundMessageId, startedAt) =>
    Effect.try({
      catch: (cause) => journalError('beginOnce', cause),
      try: () => transaction(inboundMessageId, startedAt.toISOString()),
    });
};

const makeFinish = (database: Database): LikeJournal['finish'] => {
  const transaction = database.transaction(
    (attemptId: string, outcome: 'Failed' | 'Succeeded', reason: string | null, at: string) => {
      const result = database.run(
        `UPDATE like_attempts SET state = ?, finished_at = ?, error = ?
         WHERE id = ? AND state = 'Started'`,
        [outcome, at, reason, attemptId],
      );
      if (result.changes !== 1) {
        throw new Error('Like attempt is missing or already terminal');
      }
      database.run(
        `INSERT INTO like_status(
           singleton, available, degraded, last_success_at,
           last_failure_at, last_failure_reason, updated_at
         ) VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           available = excluded.available,
           degraded = excluded.degraded,
           last_success_at = COALESCE(excluded.last_success_at, like_status.last_success_at),
           last_failure_at = COALESCE(excluded.last_failure_at, like_status.last_failure_at),
           last_failure_reason = COALESCE(excluded.last_failure_reason, like_status.last_failure_reason),
           updated_at = excluded.updated_at`,
        [
          outcome === 'Succeeded' ? 1 : 0,
          outcome === 'Succeeded' ? 0 : 1,
          outcome === 'Succeeded' ? at : null,
          outcome === 'Failed' ? at : null,
          reason,
          at,
        ],
      );
    },
  );
  return (attemptId, outcome, reason, finishedAt) =>
    Effect.try({
      catch: (cause) => journalError('finish', cause),
      try: () => {
        transaction(attemptId, outcome, reason, finishedAt.toISOString());
      },
    });
};

const makeLikeJournal = (database: Database): LikeJournal => ({
  beginOnce: makeBeginOnce(database),
  finish: makeFinish(database),
  status: Effect.try({
    catch: (cause) => journalError('status', cause),
    try: () => readStatus(database),
  }),
});

export { makeLikeJournal };
export type { LikeJournal, LikeStatus };
