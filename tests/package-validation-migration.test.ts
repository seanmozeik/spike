import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
  createOldestJournal,
  currentSchemaVersion,
  journalVersion,
  preservedJournalRecords,
  seedCurrentApprovalRecord,
} from '../scripts/package-validation-journal';
import { expectedVersionOneRecords } from '../scripts/package-validation-journal-expected';
import {
  expectedCurrentMigrationContract,
  expectedVersionOneSchema,
  readCurrentMigrationContract,
  readJournalSchemaContract,
  seedCurrentScheduleRecords,
} from '../scripts/package-validation-journal-schema';
import { applyMigrations } from '../src/journal/migrations-runner';

it('preserves every seeded version-one record while moving thread identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spike-oldest-schema-'));
  const databasePath = path.join(root, 'spike.db');
  try {
    createOldestJournal(databasePath);
    expect(preservedJournalRecords(databasePath)).toEqual(expectedVersionOneRecords);
    expect(readJournalSchemaContract(databasePath)).toEqual(expectedVersionOneSchema);

    const rerunDatabase = new Database(databasePath, { strict: true });
    try {
      applyMigrations(rerunDatabase);
    } finally {
      rerunDatabase.close();
    }

    expect(journalVersion(databasePath)).toBe(currentSchemaVersion);
    expect(preservedJournalRecords(databasePath)).toEqual(expectedVersionOneRecords);
    expect(readCurrentMigrationContract(databasePath)).toEqual(expectedCurrentMigrationContract);

    seedCurrentApprovalRecord(databasePath);
    seedCurrentScheduleRecords(databasePath);
    const currentRecords = preservedJournalRecords(databasePath);
    expect(currentRecords.approvals).toHaveLength(1);
    expect(currentRecords.schedules).toHaveLength(1);
    expect(currentRecords.scheduledRuns).toHaveLength(1);
    expect(currentRecords.scheduleToolCalls).toHaveLength(1);

    const database = new Database(databasePath, { strict: true });
    try {
      applyMigrations(database);
    } finally {
      database.close();
    }
    expect(preservedJournalRecords(databasePath)).toEqual(currentRecords);
    expect(readCurrentMigrationContract(databasePath)).toEqual(expectedCurrentMigrationContract);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
