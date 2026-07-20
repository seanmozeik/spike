import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import type { SpikeConfig } from '../app-config';
import { makeDeliveryJournal } from '../delivery/journal';
import { openMessagesTransport } from '../delivery/messages-transport';
import { makeDeliveryService, type DeliveryService } from '../delivery/service';
import type { OutageDelivery } from './service';

const withDelivery = (
  database: Database,
  config: SpikeConfig,
  use: (service: DeliveryService) => Effect.Effect<void, unknown>,
): Effect.Effect<void, unknown> =>
  Effect.scoped(
    Effect.gen(function* outageDelivery() {
      const transport = yield* Effect.acquireRelease(
        openMessagesTransport(config.messagesDatabase, config),
        (resource) => Effect.sync(resource.close),
      );
      yield* use(makeDeliveryService(makeDeliveryJournal(database), transport));
    }),
  );

const makeOutageDelivery = (database: Database, config: SpikeConfig): OutageDelivery => ({
  deliver: (episodeId, text, at): Effect.Effect<void, unknown> =>
    withDelivery(database, config, (service) => service.deliverOutageNotice(episodeId, text, at)),
});

export { makeOutageDelivery };
