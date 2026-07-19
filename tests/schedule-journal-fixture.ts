import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';

import { openJournal } from '../src/database';
import { makeScheduleJournal } from '../src/schedule/journal';

const roots: string[] = [];

const cleanupScheduleJournalFixtures = (): void => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
};

const makeJournalFixture = Effect.fn('Test.makeScheduleJournalFixture')(
  function* makeScheduleJournalFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-schedule-journal-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    return { handle, journal: makeScheduleJournal(handle.database) };
  },
);

export { cleanupScheduleJournalFixtures, makeJournalFixture };
