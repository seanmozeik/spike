import { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { expect } from 'vitest';

import { tryJournalTransaction } from '../src/errors';
import { makeLikeJournal } from '../src/like/journal';

it.effect('preserves journal transaction tag, cause, message, and operation', () =>
  Effect.gen(function* journalFailure() {
    const cause = new Error('database is locked');
    const result = yield* Effect.result(
      tryJournalTransaction('recordExample', 'example journal transaction failed', () => {
        throw cause;
      }),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: 'JournalTransactionError',
        message: 'example journal transaction failed',
        transaction: 'recordExample',
      });
      expect(result.failure.cause).toBe(cause);
    }
  }),
);

it.effect('keeps representative journal adapter error metadata stable', () =>
  Effect.gen(function* adapterFailure() {
    const database = new Database(':memory:', { strict: true });
    const result = yield* Effect.result(makeLikeJournal(database).status);
    database.close();

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: 'JournalTransactionError',
        message: 'Like journal transaction failed: status',
        transaction: 'status',
      });
      expect(result.failure.cause).toBeInstanceOf(Error);
    }
  }),
);
