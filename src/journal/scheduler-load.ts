import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import { GenerationId } from '../domain/ids';
import { JournalTransactionError } from '../errors';
import type { SchedulerState } from '../scheduler/model';
import { isGenerationSettled, rotateCurrentGeneration } from './scheduler-generation';
import {
  currentGeneration,
  readSchedulerState,
  writeSchedulerState,
} from './scheduler-state-store';

const makeLoadSchedulerState = (database: Database) => {
  const transaction = database.transaction((now: string): SchedulerState => {
    const generationId = currentGeneration(database, now);
    let state = readSchedulerState(database, generationId);
    if (
      !state.configurationCurrent &&
      state.active === null &&
      state.pool.length === 0 &&
      isGenerationSettled(database, generationId)
    ) {
      const newGenerationId = GenerationId.make(randomUUID());
      rotateCurrentGeneration(database, generationId, newGenerationId, now);
      state = {
        ...state,
        codexThreadId: null,
        configurationCurrent: true,
        generationBroken: false,
        generationId: newGenerationId,
      };
    }
    writeSchedulerState(database, state, now);
    return state;
  });
  return (now: Date): Effect.Effect<SchedulerState, JournalTransactionError> =>
    Effect.try({
      catch: (cause) =>
        new JournalTransactionError({
          cause,
          message: 'scheduler journal transaction failed: loadOrCreate',
          transaction: 'loadOrCreate',
        }),
      try: () => transaction(now.toISOString()),
    });
};

export { makeLoadSchedulerState };
