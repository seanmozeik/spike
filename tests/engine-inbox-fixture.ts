import { Effect } from 'effect';

import { MessagesRowId } from '../src/domain/ids';
import type { ObservedMessage } from '../src/domain/inbound';
import { MessagesQueryError } from '../src/errors';
import type { InboxScan, MessagesInboxHandle } from '../src/messages-inbox';

interface InboxTrace {
  failuresRemaining: number;
  readonly onScan: ((scan: number) => Effect.Effect<void>) | undefined;
  scans: number;
}

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
  trace: InboxTrace,
): MessagesInboxHandle => ({
  close: (): void => undefined,
  frontier: Effect.sync(() => latestRowId(queue)),
  refresh: Effect.void,
  scanAfter: (cursor): Effect.Effect<InboxScan, MessagesQueryError> =>
    Effect.gen(function* scanFixtureInbox() {
      trace.scans += 1;
      if (trace.failuresRemaining > 0) {
        trace.failuresRemaining -= 1;
        return yield* new MessagesQueryError({
          cause: new Error('scripted inbox scan failure'),
          message: 'scripted inbox scan failure',
          operation: 'fixture-scan',
        });
      }
      const messages = queue.filter(({ rowId }) => rowId > cursor);
      const frontier =
        messages.length > 0
          ? latestRowId(messages)
          : MessagesRowId.make(Math.max(cursor, idleFrontier ?? cursor));
      if (trace.onScan !== undefined) {
        yield* trace.onScan(trace.scans);
      }
      return { frontier, messages } satisfies InboxScan;
    }),
});

export { makeInbox };
export type { InboxTrace };
