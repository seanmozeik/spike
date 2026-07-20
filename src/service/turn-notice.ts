import { Effect } from 'effect';

import type { TurnNoticeKind } from '../delivery/model';
import type { TurnIdentity } from '../scheduler/model';
import type { EngineContext } from './context';

const deliverTurnNotice = Effect.fn('SpikeEngine.deliverTurnNotice')(
  function* deliverOwnedTurnNotice(
    context: EngineContext,
    identity: TurnIdentity,
    sourceId: string,
    kind: TurnNoticeKind,
    text: string,
  ) {
    const prepared = yield* context.options.delivery.prepareTurnNotice(
      identity,
      sourceId,
      kind,
      text,
      context.now(),
    );
    if (prepared === null) {
      return;
    }
    const controller = yield* Effect.promise(() => context.controllerReady.promise);
    yield* controller.runIfTurnOwned(
      identity,
      context.options.delivery.deliverPreparedTurnNotice(prepared),
    );
  },
);

export { deliverTurnNotice };
