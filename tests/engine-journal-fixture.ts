import { Effect } from 'effect';

import { openJournal } from '../src/database';

const openFixtureJournal = Effect.fn('Test.openFixtureJournal')(function* openFixtureJournal(
  databasePath: string,
  beforeOpen: ((databasePath: string) => void) | undefined,
) {
  if (beforeOpen !== undefined) {
    const bootstrap = yield* openJournal(databasePath);
    bootstrap.close();
    beforeOpen(databasePath);
  }
  return yield* openJournal(databasePath);
});

export { openFixtureJournal };
