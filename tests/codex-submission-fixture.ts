import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';

import type { ClassifiedOutput } from '../src/codex/output-classifier';
import type { ThreadSnapshot } from '../src/codex/reconcile';
import type { CodexRuntime } from '../src/codex/runtime';
import { openJournal, type JournalHandle } from '../src/database';
import { CodexThreadId, InputBatchId, LogicalTurnId } from '../src/domain/ids';
import { makeCodexJournal, type CodexJournal } from '../src/journal/codex-journal';

interface SubmissionFixture {
  readonly databasePath: string;
  readonly handle: JournalHandle;
  readonly journal: CodexJournal;
}

const roots: string[] = [];

const BatchId = {
  initial: InputBatchId.make('batch-initial'),
  steerOne: InputBatchId.make('batch-steer-one'),
  steerTwo: InputBatchId.make('batch-steer-two'),
} as const;

const cleanupSubmissionFixtures = (): void => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
};

const emptyThread = (): ThreadSnapshot => ({ id: 'thread', turns: [] });

const makeRuntime = (
  readThread: CodexRuntime['readThread'],
  startTurn: CodexRuntime['startTurn'],
): CodexRuntime => ({
  accountId: 'default',
  addConnectionCloseListener: (): (() => void) => (): void => undefined,
  addNotificationListener: (): (() => void) => (): void => undefined,
  addServerRequestListener: (): (() => void) => (): void => undefined,
  archiveThread: (): Effect.Effect<void> => Effect.void,
  close: (): Promise<void> => Promise.resolve(),
  health: Effect.void,
  interruptTurn: (): Effect.Effect<void> => Effect.void,
  loadedThreads: Effect.succeed([CodexThreadId.make('thread')]),
  rateLimits: Effect.succeed({}),
  readThread,
  respondToServerRequest: (): Promise<void> => Promise.resolve(),
  resumeThread: (): Effect.Effect<void> => Effect.void,
  startThread: Effect.succeed(CodexThreadId.make('thread')),
  startTurn,
  steerTurn: (): Effect.Effect<void> => Effect.void,
  usage: Effect.succeed({}),
  waitForTurn: (): Effect.Effect<ClassifiedOutput> =>
    Effect.succeed({ acknowledgement: null, finalAnswer: 'Done.' }),
});

const makeSubmissionFixture = Effect.fn('Test.makeCodexSubmissionFixture')(
  function* makeCodexSubmissionFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-submission-'));
    roots.push(root);
    const databasePath = path.join(root, 'spike.db');
    const handle = yield* openJournal(databasePath);
    const now = new Date().toISOString();
    handle.database.run(
      "INSERT INTO generations VALUES ('generation', 1, 'Current', ?, NULL, 'thread', NULL, NULL)",
      [now],
    );
    handle.database.run(
      "INSERT INTO logical_turns VALUES ('logical-turn', 'generation', 1, 'Collecting', 'correlation', ?, NULL, NULL)",
      [now],
    );
    handle.database.run(
      `INSERT INTO input_batches(id, logical_turn_id, sequence, kind, fingerprint, created_at)
       VALUES
         (?, 'logical-turn', 1, 'Initial', 'initial', ?),
         (?, 'logical-turn', 2, 'Steer', 'steer-one', ?),
         (?, 'logical-turn', 3, 'Steer', 'steer-two', ?)`,
      [BatchId.initial, now, BatchId.steerOne, now, BatchId.steerTwo, now],
    );
    return {
      databasePath,
      handle,
      journal: makeCodexJournal(handle.database),
    } satisfies SubmissionFixture;
  },
);

const withJournal = <A>(
  run: (runtimeJournal: CodexJournal) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> =>
  Effect.acquireUseRelease(
    makeSubmissionFixture(),
    (fixture) => run(fixture.journal),
    (fixture) =>
      Effect.sync(() => {
        fixture.handle.close();
      }),
  );

const input = {
  batchId: BatchId.initial,
  frontier: 'Read' as const,
  input: 'hello',
  kind: 'Start' as const,
  logicalTurnId: LogicalTurnId.make('logical-turn'),
  threadId: CodexThreadId.make('thread'),
};

export {
  BatchId,
  cleanupSubmissionFixtures,
  emptyThread,
  input,
  makeRuntime,
  makeSubmissionFixture,
  withJournal,
};
export type { SubmissionFixture };
