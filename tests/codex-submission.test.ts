import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { ClassifiedOutput } from '../src/codex/output-classifier';
import type { ThreadSnapshot } from '../src/codex/reconcile';
import type { CodexRuntime } from '../src/codex/runtime';
import { submitCodexInput } from '../src/codex/submission';
import { openJournal } from '../src/database';
import { CodexThreadId, CodexTurnId, LogicalTurnId } from '../src/domain/ids';
import { CodexRuntimeError } from '../src/errors';
import { makeCodexJournal } from '../src/journal/codex-journal';

const roots: string[] = [];

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
  archiveThread: (): Effect.Effect<void> => Effect.void,
  close: (): Promise<void> => Promise.resolve(),
  health: Effect.void,
  interruptTurn: (): Effect.Effect<void> => Effect.void,
  loadedThreads: Effect.succeed([CodexThreadId.make('thread')]),
  rateLimits: Effect.succeed({}),
  readThread,
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
    const result = yield* run(makeCodexJournal(handle.database));
    handle.close();
    return result;
  });

const input = {
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
