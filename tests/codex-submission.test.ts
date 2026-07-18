import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { ClassifiedOutput } from '../src/codex/output-classifier';
import type { ThreadSnapshot } from '../src/codex/reconcile';
import type { CodexRuntime } from '../src/codex/runtime';
import { recoverCodexInput, submitCodexInput } from '../src/codex/submission';
import { openJournal } from '../src/database';
import { CodexThreadId, CodexTurnId, InputBatchId, LogicalTurnId } from '../src/domain/ids';
import { CodexRuntimeError } from '../src/errors';
import { makeCodexJournal } from '../src/journal/codex-journal';

const roots: string[] = [];

const BatchId = {
  initial: InputBatchId.make('batch-initial'),
  steerOne: InputBatchId.make('batch-steer-one'),
  steerTwo: InputBatchId.make('batch-steer-two'),
} as const;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

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

const withJournal = <A>(
  run: (runtimeJournal: ReturnType<typeof makeCodexJournal>) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> =>
  Effect.gen(function* submissionFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-submission-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
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
    const result = yield* run(makeCodexJournal(handle.database));
    handle.close();
    return result;
  });

const input = {
  batchId: BatchId.initial,
  frontier: 'Read' as const,
  input: 'hello',
  kind: 'Start' as const,
  logicalTurnId: LogicalTurnId.make('logical-turn'),
  threadId: CodexThreadId.make('thread'),
};

it('persists the frontier before submitting and accepts the returned turn', async () => {
  await Effect.runPromise(
    withJournal((journal) =>
      Effect.gen(function* immediateSubmission() {
        const runtime = makeRuntime(
          () => Effect.succeed(emptyThread()),
          () => Effect.succeed(CodexTurnId.make('turn-immediate')),
        );
        expect(yield* submitCodexInput(runtime, journal, input)).toBe('turn-immediate');
        expect(yield* journal.loadNonterminalAttempts).toMatchObject([
          { state: 'Accepted', submissionKind: 'Start' },
        ]);
      }),
    ),
  );
});

it('accepts successive steers without claiming the already-active Codex turn id', async () => {
  await Effect.runPromise(
    withJournal((journal) =>
      Effect.gen(function* acceptedSteer() {
        const activeTurnId = CodexTurnId.make('turn-active');
        let steerCalls = 0;
        const runtime: CodexRuntime = {
          ...makeRuntime(
            () => Effect.succeed(emptyThread()),
            () => Effect.succeed(activeTurnId),
          ),
          steerTurn: () =>
            Effect.sync(() => {
              steerCalls += 1;
            }),
        };
        yield* submitCodexInput(runtime, journal, input);
        for (const [index, followUp] of ['follow-up one', 'follow-up two'].entries()) {
          expect(
            yield* submitCodexInput(runtime, journal, {
              ...input,
              batchId: index === 0 ? BatchId.steerOne : BatchId.steerTwo,
              expectedTurnId: activeTurnId,
              input: followUp,
              kind: 'Steer',
            }),
          ).toBe(activeTurnId);
        }

        const attempts = yield* journal.loadNonterminalAttempts;
        expect(steerCalls).toBe(2);
        expect(attempts.find(({ submissionKind }) => submissionKind === 'Start')).toMatchObject({
          state: 'Accepted',
          turnId: activeTurnId,
        });
        expect(
          attempts
            .filter(({ submissionKind }) => submissionKind === 'Steer')
            .map(({ state, turnId }) => ({ state, turnId })),
        ).toStrictEqual([
          { state: 'Accepted', turnId: null },
          { state: 'Accepted', turnId: null },
        ]);
      }),
    ),
  );
});

it('recovers an accepted steer without resubmitting after the scheduler-save crash window', async () => {
  await Effect.runPromise(
    withJournal((journal) =>
      Effect.gen(function* recoverAcceptedSteer() {
        const activeTurnId = CodexTurnId.make('turn-active');
        let reads = 0;
        let steerCalls = 0;
        const runtime: CodexRuntime = {
          ...makeRuntime(
            () =>
              Effect.sync(() => {
                reads += 1;
                return emptyThread();
              }),
            () => Effect.succeed(activeTurnId),
          ),
          steerTurn: () =>
            Effect.sync(() => {
              steerCalls += 1;
            }),
        };
        yield* submitCodexInput(runtime, journal, input);
        const steerInput = {
          batchId: BatchId.steerOne,
          expectedTurnId: activeTurnId,
          input: 'follow-up',
          kind: 'Steer' as const,
          logicalTurnId: input.logicalTurnId,
          threadId: input.threadId,
        };
        yield* submitCodexInput(runtime, journal, { ...steerInput, frontier: 'Read' });
        const attempt = (yield* journal.loadNonterminalAttempts).find(
          ({ submissionKind }) => submissionKind === 'Steer',
        );
        if (attempt === undefined) {
          throw new Error('expected an accepted steer attempt');
        }
        const beforeRecovery = { reads, steerCalls };

        expect(yield* recoverCodexInput(runtime, journal, attempt, steerInput)).toBe(activeTurnId);
        expect({ reads, steerCalls }).toStrictEqual(beforeRecovery);
      }),
    ),
  );
});

it('uses a known-empty frontier for the first turn without reading an unmaterialized rollout', async () => {
  let reads = 0;
  await Effect.runPromise(
    withJournal((journal) =>
      Effect.gen(function* firstTurn() {
        const runtime = makeRuntime(
          () => {
            reads += 1;
            return Effect.die(new Error('fresh thread must not be read before its first turn'));
          },
          () => Effect.succeed(CodexTurnId.make('turn-first')),
        );
        expect(yield* submitCodexInput(runtime, journal, { ...input, frontier: 'Empty' })).toBe(
          'turn-first',
        );
        expect(reads).toBe(0);
        expect(yield* journal.loadNonterminalAttempts).toMatchObject([
          { frontier: { itemIds: [], turnIds: [] }, state: 'Accepted' },
        ]);
      }),
    ),
  );
});

it('reconciles one matching user item after a lost submission response', async () => {
  let clientId = '';
  let reads = 0;
  await Effect.runPromise(
    withJournal((journal) =>
      Effect.gen(function* lostResponse() {
        const runtime = makeRuntime(
          () => {
            reads += 1;
            return Effect.succeed(
              reads === 1
                ? emptyThread()
                : {
                    id: 'thread',
                    turns: [
                      {
                        id: 'turn-reconciled',
                        items: [{ clientId, id: 'user-item', type: 'userMessage' }],
                      },
                    ],
                  },
            );
          },
          (options) => {
            clientId = options.clientUserMessageId;
            return Effect.fail(
              new CodexRuntimeError({
                cause: new Error('socket closed'),
                message: 'lost turn/start response',
                operation: 'turn/start',
              }),
            );
          },
        );
        expect(yield* submitCodexInput(runtime, journal, input)).toBe('turn-reconciled');
      }),
    ),
  );
});

it('retries once when reconciliation finds no matching user item', async () => {
  let submissions = 0;
  await Effect.runPromise(
    withJournal((journal) =>
      Effect.gen(function* absentSubmission() {
        const runtime = makeRuntime(
          () => Effect.succeed(emptyThread()),
          () => {
            submissions += 1;
            return submissions === 1
              ? Effect.fail(
                  new CodexRuntimeError({
                    cause: new Error('socket closed'),
                    message: 'lost turn/start response',
                    operation: 'turn/start',
                  }),
                )
              : Effect.succeed(CodexTurnId.make('turn-retried'));
          },
        );
        expect(yield* submitCodexInput(runtime, journal, input)).toBe('turn-retried');
        expect(submissions).toBe(2);
      }),
    ),
  );
});
