import { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import { makeDeliveryJournal } from '../src/delivery/journal';
import type { MessagesTransport } from '../src/delivery/messages-transport';
import { makeDeliveryService } from '../src/delivery/service';
import type { OutageDelivery } from '../src/outage/service';

const outageDeliveryFixture: OutageDelivery = { deliver: () => Effect.void };

const makeDeliveredOutageFixture = (databasePath: string): OutageDelivery => ({
  deliver: (episodeId, text, at): Effect.Effect<void, unknown> => {
    let sent = false;
    const transport: MessagesTransport = {
      close: (): void => undefined,
      findMatchingAfter: () =>
        Effect.succeed(sent ? { guid: `outage-${episodeId}`, rowId: 1 } : null),
      frontier: Effect.succeed(0),
      refresh: Effect.void,
      send: () =>
        Effect.sync(() => {
          sent = true;
        }),
    };
    return Effect.acquireUseRelease(
      Effect.sync(() => new Database(databasePath, { strict: true })),
      (database) =>
        makeDeliveryService(makeDeliveryJournal(database), transport).deliverOutageNotice(
          episodeId,
          text,
          at,
        ),
      (database) =>
        Effect.sync(() => {
          database.close();
        }),
    );
  },
});

export { makeDeliveredOutageFixture, outageDeliveryFixture };
