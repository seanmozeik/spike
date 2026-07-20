import { Effect } from 'effect';

import { makeApprovalManager } from '../approval/manager';
import type { EngineContext } from './context';

const seedInboxCursor = (context: EngineContext): Effect.Effect<void, unknown> =>
  Effect.gen(function* seedCursor() {
    const existing = yield* context.journal.inboxCursor(context.options.chatGuid);
    if (existing === null) {
      const frontier = yield* context.options.inbox.frontier;
      yield* context.journal.initializeInboxCursor(
        context.options.chatGuid,
        frontier,
        context.now(),
      );
    }
  });

const initializeConversation = Effect.fn('SpikeEngine.initializeConversation')(
  function* initializeConversation(context: EngineContext) {
    if (context.conversationReady.value) {
      return;
    }
    yield* seedInboxCursor(context);
    yield* context.options.delivery.recover;
    context.approval = yield* makeApprovalManager({
      database: context.options.database,
      delivery: context.options.delivery,
      ...(context.options.approvalExpiryMs === undefined
        ? {}
        : { expiryMs: context.options.approvalExpiryMs }),
      now: context.now,
      onWake: () => {
        context.wakes.signal('Approval');
      },
      runtime: context.options.runtime,
    });
    context.conversationReady.value = true;
  },
);

export { initializeConversation };
