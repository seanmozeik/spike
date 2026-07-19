import { Effect } from 'effect';

import { MessagesRowId } from '../src/domain/ids';
import type { ObservedMessage } from '../src/domain/inbound';
import type { InboxScan, MessagesInboxHandle } from '../src/messages-inbox';

const latestRowId = (queue: readonly ObservedMessage[]): MessagesRowId => {
  let latest = 0;
  for (const message of queue) {
    latest = Math.max(latest, message.rowId);
  }
  return MessagesRowId.make(latest);
};

const makeInbox = (
  queue: ObservedMessage[],
  idleFrontier: number | undefined,
): MessagesInboxHandle => ({
  close: (): void => undefined,
  frontier: Effect.sync(() => latestRowId(queue)),
  refresh: Effect.void,
  scanAfter: (cursor): Effect.Effect<InboxScan> => {
    const messages = queue.filter(({ rowId }) => rowId > cursor);
    return Effect.succeed({
      frontier:
        messages.length > 0
          ? latestRowId(messages)
          : MessagesRowId.make(Math.max(cursor, idleFrontier ?? cursor)),
      messages,
    });
  },
});

export { makeInbox };
