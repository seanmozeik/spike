import { Effect, Result } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { canonicalInputFingerprint, type ThreadSnapshot } from '../src/codex/reconcile';
import type { CodexRuntime } from '../src/codex/runtime';
import {
  recoverCodexInput,
  submitCodexInput,
  type CodexInput,
  type SubmitCodexInput,
} from '../src/codex/submission';
import { openJournal, type JournalHandle } from '../src/database';
import { AccountId, CodexTurnId } from '../src/domain/ids';
import { GenerationBroken } from '../src/errors';
import {
  makeCodexJournal,
  type CodexAttemptRecord,
  type CodexJournal,
} from '../src/journal/codex-journal';
import {
  BatchId,
  cleanupSubmissionFixtures,
  emptyThread,
  input,
  makeRuntime,
  makeSubmissionFixture,
} from './codex-submission-fixture';

afterEach(cleanupSubmissionFixtures);

const remoteSnapshot = (turnId: string, clientUserMessageId: string): ThreadSnapshot => ({
  id: 'thread',
  turns: [
    {
      id: turnId,
      items: [{ clientId: clientUserMessageId, id: `item-${turnId}`, type: 'userMessage' }],
      status: 'inProgress',
    },
  ],
});

interface RestartedAttempt {
  readonly attempt: CodexAttemptRecord;
  readonly fingerprint: string;
  readonly handle: JournalHandle;
  readonly journal: CodexJournal;
}

const restartPreparedAttempt = async (request: CodexInput): Promise<RestartedAttempt> => {
  const fixture = await Effect.runPromise(makeSubmissionFixture());
  const fingerprint = canonicalInputFingerprint(
    request.input,
    request.attachments.map(({ contentHash }) => contentHash),
  );
  await Effect.runPromise(
    fixture.journal.beginCodexAttempt({
      accountId: AccountId.make('account'),
      batchId: request.batchId,
      fingerprint,
      frontier: { itemIds: [], turnIds: [] },
      logicalTurnId: request.logicalTurnId,
      startedAt: new Date('2026-07-19T12:00:00.000Z'),
      submissionKind: request.kind,
      threadId: request.threadId,
    }),
  );
  fixture.handle.close();
  const handle = await Effect.runPromise(openJournal(fixture.databasePath));
  const journal = makeCodexJournal(handle.database);
  const [attempt] = await Effect.runPromise(journal.loadNonterminalAttempts);
  if (attempt === undefined) {
    handle.close();
    throw new Error('expected a prepared attempt after restart');
  }
  return { attempt, fingerprint, handle, journal };
};

const crashAfterSubmission = async (kind: 'Start' | 'Steer'): Promise<void> => {
  const fixture = await Effect.runPromise(makeSubmissionFixture());
  const activeTurnId = CodexTurnId.make(kind === 'Start' ? 'turn-started' : 'turn-active');
  const submittedInput: SubmitCodexInput = {
    ...input,
    ...(kind === 'Steer' ? { batchId: BatchId.steerOne, expectedTurnId: activeTurnId } : {}),
    frontier: kind === 'Start' ? 'Empty' : 'Read',
    input: kind === 'Start' ? 'start after crash' : 'steer after crash',
    kind,
  };
  let clientUserMessageId = '';
  let remote: ThreadSnapshot = emptyThread();
  let submissions = 0;
  const crash = new Error(`simulated crash after ${kind.toLowerCase()} submission`);
  const recordRemoteSubmission = (id: string): Effect.Effect<never> =>
    Effect.sync(() => {
      expect(fixture.handle.database.inTransaction).toBe(false);
      submissions += 1;
      clientUserMessageId = id;
      remote = remoteSnapshot(activeTurnId, id);
    }).pipe(Effect.andThen(Effect.die(crash)));
  const crashingRuntime: CodexRuntime = {
    ...makeRuntime(
      () => Effect.succeed(remote),
      ({ clientUserMessageId: id }) => recordRemoteSubmission(id),
    ),
    steerTurn: ({ clientUserMessageId: id }) => recordRemoteSubmission(id),
  };

  await expect(
    Effect.runPromise(submitCodexInput(crashingRuntime, fixture.journal, submittedInput)),
  ).rejects.toThrow(crash.message);
  expect(submissions).toBe(1);
  expect(clientUserMessageId).not.toBe('');
  expect(await Effect.runPromise(fixture.journal.loadNonterminalAttempts)).toMatchObject([
    { batchId: submittedInput.batchId, state: 'Prepared', submissionKind: kind },
  ]);
  fixture.handle.close();

  const restartedHandle = await Effect.runPromise(openJournal(fixture.databasePath));
  try {
    const restartedJournal = makeCodexJournal(restartedHandle.database);
    const [attempt] = await Effect.runPromise(restartedJournal.loadNonterminalAttempts);
    if (attempt === undefined) {
      throw new Error('expected the durable attempt after restart');
    }
    const recoveryRuntime: CodexRuntime = {
      ...makeRuntime(
        () => Effect.succeed(remote),
        () =>
          Effect.sync(() => {
            submissions += 1;
            return activeTurnId;
          }),
      ),
      steerTurn: () =>
        Effect.sync(() => {
          submissions += 1;
        }),
    };

    expect(
      await Effect.runPromise(
        recoverCodexInput(recoveryRuntime, restartedJournal, attempt, submittedInput),
      ),
    ).toBe(activeTurnId);
    expect(submissions).toBe(1);
    expect(await Effect.runPromise(restartedJournal.loadNonterminalAttempts)).toMatchObject([
      { batchId: submittedInput.batchId, state: 'Accepted', submissionKind: kind },
    ]);
  } finally {
    restartedHandle.close();
  }
};

it('does not cross the Codex side-effect boundary when attempt creation faults', async () => {
  const fixture = await Effect.runPromise(makeSubmissionFixture());
  let submissions = 0;
  const runtime = makeRuntime(
    () => Effect.succeed(emptyThread()),
    () =>
      Effect.sync(() => {
        expect(fixture.handle.database.inTransaction).toBe(false);
        submissions += 1;
        return CodexTurnId.make('turn-after-retry');
      }),
  );
  try {
    fixture.handle.database.run(
      `CREATE TEMP TRIGGER fail_attempt_creation BEFORE INSERT ON codex_attempts
       BEGIN SELECT RAISE(ABORT, 'forced attempt creation fault'); END`,
    );

    const failed = await Effect.runPromise(
      submitCodexInput(runtime, fixture.journal, { ...input, frontier: 'Empty' }).pipe(
        Effect.result,
      ),
    );

    expect(Result.isFailure(failed)).toBe(true);
    expect(submissions).toBe(0);
    expect(
      fixture.handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM codex_attempts')
        .get()?.count,
    ).toBe(0);

    fixture.handle.database.run('DROP TRIGGER fail_attempt_creation');
    expect(
      await Effect.runPromise(
        submitCodexInput(runtime, fixture.journal, { ...input, frontier: 'Empty' }),
      ),
    ).toBe('turn-after-retry');
    expect(submissions).toBe(1);
    expect(await Effect.runPromise(fixture.journal.loadNonterminalAttempts)).toMatchObject([
      { batchId: BatchId.initial, state: 'Accepted', submissionKind: 'Start' },
    ]);
  } finally {
    fixture.handle.close();
  }
});

it('reconciles a start after crashing beyond the remote submission boundary', async () => {
  await crashAfterSubmission('Start');
});

it('reconciles a steer after crashing beyond the remote submission boundary', async () => {
  await crashAfterSubmission('Steer');
});

it('retries the exact structured input after restart', async () => {
  const attachment = {
    contentHash: 'a'.repeat(64),
    mimeType: 'image/png' as const,
    path: '/staged/a.png',
  };
  const request: CodexInput = { ...input, attachments: [attachment], input: 'retry this image' };
  const restarted = await restartPreparedAttempt(request);
  let submitted: Parameters<CodexRuntime['startTurn']>[0] | undefined;
  const turnId = CodexTurnId.make('turn-after-restart');
  const runtime = makeRuntime(
    () => Effect.succeed(emptyThread()),
    (submission) =>
      Effect.sync(() => {
        submitted = submission;
        return turnId;
      }),
  );
  try {
    expect(restarted.attempt.inputFingerprint).toBe(restarted.fingerprint);
    expect(
      await Effect.runPromise(
        recoverCodexInput(runtime, restarted.journal, restarted.attempt, request),
      ),
    ).toBe(turnId);
    expect(submitted).toMatchObject({ attachments: [attachment], input: request.input });
  } finally {
    restarted.handle.close();
  }
});

it('breaks recovery instead of retrying drifted structured input', async () => {
  const original: CodexInput = {
    ...input,
    attachments: [{ contentHash: 'a'.repeat(64), mimeType: 'image/png', path: '/staged/a.png' }],
    input: 'stable request',
  };
  const restarted = await restartPreparedAttempt(original);
  let submissions = 0;
  const runtime = makeRuntime(
    () => Effect.succeed(emptyThread()),
    () =>
      Effect.sync(() => {
        submissions += 1;
        return CodexTurnId.make('must-not-submit');
      }),
  );
  try {
    const result = await Effect.runPromise(
      recoverCodexInput(runtime, restarted.journal, restarted.attempt, {
        ...original,
        attachments: [
          { contentHash: 'b'.repeat(64), mimeType: 'image/png', path: '/staged/b.png' },
        ],
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(GenerationBroken);
      expect(result.failure.message).toContain('changed before retry');
    }
    expect(submissions).toBe(0);
  } finally {
    restarted.handle.close();
  }
});
