import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import { CodexThreadId, type GenerationId } from '../domain/ids';
import { JournalTransactionError } from '../errors';

interface GenerationThreadJournal {
  readonly bindGenerationThread: (
    generationId: GenerationId,
    threadId: CodexThreadId,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly loadGenerationThreadState: (
    generationId: GenerationId,
  ) => Effect.Effect<GenerationThreadState | null, JournalTransactionError>;
  readonly replaceUnusedGenerationThread: (
    generationId: GenerationId,
    expectedThreadId: CodexThreadId,
    replacementThreadId: CodexThreadId,
  ) => Effect.Effect<boolean, JournalTransactionError>;
}

interface GenerationThreadState {
  readonly threadId: CodexThreadId;
  readonly unused: boolean;
}

const journalError = (transaction: string, cause: unknown): JournalTransactionError =>
  new JournalTransactionError({ cause, message: `${transaction} failed`, transaction });

const makeBindGenerationThread =
  (database: Database): GenerationThreadJournal['bindGenerationThread'] =>
  (generationId, threadId) =>
    Effect.try({
      catch: (cause) => journalError('bindGenerationThread', cause),
      try: () => {
        const result = database.run(
          'UPDATE generations SET codex_thread_id = ? WHERE id = ? AND codex_thread_id IS NULL',
          [threadId, generationId],
        );
        if (result.changes !== 1) {
          throw new Error(
            `bindGenerationThread expected one row, changed ${String(result.changes)}`,
          );
        }
      },
    });

const makeLoadGenerationThreadState =
  (database: Database): GenerationThreadJournal['loadGenerationThreadState'] =>
  (generationId) =>
    Effect.try({
      catch: (cause) => journalError('loadGenerationThreadState', cause),
      try: () => {
        const row = database
          .query<{ codex_thread_id: string | null; unused: number }, [string]>(
            `SELECT g.codex_thread_id,
                    NOT EXISTS (
                      SELECT 1 FROM codex_attempts ca
                      JOIN logical_turns lt ON lt.id = ca.logical_turn_id
                      WHERE lt.generation_id = g.id
                    ) AS unused
             FROM generations g WHERE g.id = ?`,
          )
          .get(generationId);
        if (row === null) {
          return null;
        }
        const { codex_thread_id: threadId } = row;
        if (threadId === null) {
          return null;
        }
        return { threadId: CodexThreadId.make(threadId), unused: row.unused === 1 };
      },
    });

const makeReplaceUnusedGenerationThread =
  (database: Database): GenerationThreadJournal['replaceUnusedGenerationThread'] =>
  (generationId, expectedThreadId, replacementThreadId) =>
    Effect.try({
      catch: (cause) => journalError('replaceUnusedGenerationThread', cause),
      try: () => {
        const result = database.run(
          `UPDATE generations SET codex_thread_id = ?
           WHERE id = ? AND codex_thread_id = ? AND NOT EXISTS (
             SELECT 1 FROM codex_attempts ca
             JOIN logical_turns lt ON lt.id = ca.logical_turn_id
             WHERE lt.generation_id = generations.id
           )`,
          [replacementThreadId, generationId, expectedThreadId],
        );
        return result.changes === 1;
      },
    });

const makeGenerationThreadJournal = (database: Database): GenerationThreadJournal => ({
  bindGenerationThread: makeBindGenerationThread(database),
  loadGenerationThreadState: makeLoadGenerationThreadState(database),
  replaceUnusedGenerationThread: makeReplaceUnusedGenerationThread(database),
});

export { makeGenerationThreadJournal };
export type { GenerationThreadJournal, GenerationThreadState };
