import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { openJournal } from '../src/database';
import {
  AccountId,
  CodexItemId,
  CodexThreadId,
  CodexTurnId,
  GenerationId,
  InputBatchId,
  LogicalTurnId,
} from '../src/domain/ids';
import { makeCodexJournal } from '../src/journal/codex-journal';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('persists the pre-submit frontier and reconciled turn through named transitions', () =>
  Effect.gen(function* codexJournalFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-codex-journal-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    handle.database.run(
      "INSERT INTO generations VALUES ('generation', 1, 'Current', ?, NULL, NULL, NULL, NULL)",
      [new Date().toISOString()],
    );
    handle.database.run(
      "INSERT INTO logical_turns VALUES ('logical-turn', 'generation', 1, 'Collecting', 'correlation', ?, NULL, NULL)",
      [new Date().toISOString()],
    );
    handle.database.run(
      "INSERT INTO input_batches VALUES ('input-batch', 'logical-turn', 1, 'Initial', 'batch-fingerprint', ?)",
      [new Date().toISOString()],
    );
    const journal = makeCodexJournal(handle.database);
    const attemptId = yield* journal.beginCodexAttempt({
      accountId: AccountId.make('default'),
      batchId: InputBatchId.make('input-batch'),
      fingerprint: 'fingerprint',
      frontier: { itemIds: ['item-before'], turnIds: ['turn-before'] },
      logicalTurnId: LogicalTurnId.make('logical-turn'),
      startedAt: new Date(),
      submissionKind: 'Start',
    });
    expect(yield* journal.loadNonterminalAttempts).toMatchObject([
      { batchId: 'input-batch', state: 'Prepared', submissionKind: 'Start' },
    ]);
    yield* journal.recordSubmissionUnknown(attemptId);
    yield* journal.acceptCodexTurn(
      attemptId,
      CodexThreadId.make('thread'),
      CodexTurnId.make('turn'),
    );
    yield* journal.bindGenerationThread(
      GenerationId.make('generation'),
      CodexThreadId.make('thread'),
    );
    yield* journal.recordAgentItem(
      attemptId,
      CodexItemId.make('agent-item'),
      'agentMessage',
      { text: 'Done.' },
      new Date(),
    );
    yield* journal.recordAccountObservation(
      AccountId.make('default'),
      true,
      { weekly: { remaining: 42 } },
      null,
      new Date(),
    );
    yield* journal.recordAgentItem(
      attemptId,
      CodexItemId.make('agent-item'),
      'agentMessage',
      { text: 'Done.' },
      new Date(),
    );
    expect(
      handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM codex_agent_items')
        .get()?.count,
    ).toBe(1);
    expect(
      handle.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM account_observations')
        .get()?.count,
    ).toBe(1);
    handle.close();
  }),
);
