import { Effect, Result } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { ThreadSnapshot } from '../src/codex/reconcile';
import type { CodexRuntime } from '../src/codex/runtime';
import {
  recoverCodexInput,
  submitCodexInput,
  type SubmitCodexInput,
} from '../src/codex/submission';
import { openJournal } from '../src/database';
import { CodexTurnId } from '../src/domain/ids';
import { makeCodexJournal } from '../src/journal/codex-journal';
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
