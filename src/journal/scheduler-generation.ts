import type { Database } from 'bun:sqlite';

import type { GenerationId } from '../domain/ids';
import { SCHEDULE_CONFIGURATION_VERSION } from '../schedule/configuration';

const isGenerationSettled = (database: Database, generationId: GenerationId): boolean => {
  const row = database
    .query<{ readonly unsettled: number }, [string, string, string, string, string]>(
      `SELECT (
         EXISTS(
           SELECT 1 FROM logical_turns
           WHERE generation_id = ? AND state IN ('Collecting','Submitted','Running')
         ) OR EXISTS(
           SELECT 1 FROM codex_attempts ca
           JOIN logical_turns lt ON lt.id = ca.logical_turn_id
           WHERE lt.generation_id = ?
             AND ca.state IN ('Prepared','Submitted','SubmissionUnknown','Accepted')
         ) OR EXISTS(
           SELECT 1 FROM outbound_messages om
           JOIN logical_turns lt ON lt.id = om.logical_turn_id
           WHERE lt.generation_id = ? AND om.state IN ('Prepared','Delivering')
         ) OR EXISTS(
           SELECT 1 FROM scheduled_runs sr
           JOIN logical_turns lt ON lt.id = sr.logical_turn_id
           WHERE lt.generation_id = ? AND sr.state = 'Running'
         ) OR EXISTS(
           SELECT 1 FROM approval_requests ar
           JOIN generations g ON g.id = ?
           WHERE ar.state = 'Pending'
             AND (
               ar.logical_turn_id IN (SELECT id FROM logical_turns WHERE generation_id = g.id)
               OR ar.thread_id = g.codex_thread_id
             )
         )
       ) AS unsettled`,
    )
    .get(generationId, generationId, generationId, generationId, generationId);
  return row?.unsettled === 0;
};

const insertCurrentGeneration = (
  database: Database,
  generationId: GenerationId,
  createdAt: string,
): void => {
  database.run(
    `INSERT INTO generations(id, sequence, state, created_at, config_version)
     VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM generations), 1), 'Current', ?, ?)`,
    [generationId, createdAt, SCHEDULE_CONFIGURATION_VERSION],
  );
};

const supersedeCurrentGeneration = (
  database: Database,
  oldGenerationId: GenerationId,
  newGenerationId: GenerationId,
  rotatedAt: string,
): void => {
  const changed = database.run(
    "UPDATE generations SET state = 'Superseded', superseded_at = ? WHERE id = ? AND state = 'Current'",
    [rotatedAt, oldGenerationId],
  );
  if (changed.changes !== 1) {
    throw new Error('generation rotation lost current-generation ownership');
  }
  insertCurrentGeneration(database, newGenerationId, rotatedAt);
};

const rotateCurrentGeneration = (
  database: Database,
  oldGenerationId: GenerationId,
  newGenerationId: GenerationId,
  rotatedAt: string,
): void => {
  if (!isGenerationSettled(database, oldGenerationId)) {
    throw new Error('generation rotation requires settled durable work');
  }
  supersedeCurrentGeneration(database, oldGenerationId, newGenerationId, rotatedAt);
};

const resetCurrentGeneration = (
  database: Database,
  oldGenerationId: GenerationId,
  newGenerationId: GenerationId,
  resetAt: string,
): void => {
  supersedeCurrentGeneration(database, oldGenerationId, newGenerationId, resetAt);
};

export {
  insertCurrentGeneration,
  isGenerationSettled,
  resetCurrentGeneration,
  rotateCurrentGeneration,
};
