import { Effect } from 'effect';

import { cursorRowId } from '../journal/service';
import type { EngineContext } from './context';

const pollInbox = Effect.fn('SpikeEngine.pollInbox')(function* pollInbox(context: EngineContext) {
  const cursor = yield* context.journal.inboxCursor(context.options.chatGuid);
  const previousFrontier = cursorRowId(cursor);
  const scan = yield* context.options.inbox.scanAfter(previousFrontier);
  if (scan.messages.length > 0) {
    yield* context.journal.ingestObservedMessages(
      context.options.chatGuid,
      context.now(),
      scan.messages,
    );
    return;
  }
  if (scan.frontier > previousFrontier) {
    yield* context.journal.advanceInboxCursor(
      context.options.chatGuid,
      scan.frontier,
      context.now(),
    );
  }
});

export { pollInbox };
