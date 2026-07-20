import { it } from '@effect/vitest';
import { Effect } from 'effect';
import * as Context from 'effect/Context';
import { expect } from 'vitest';

import type { LikeAcknowledgement } from '../src/like/adapter';
import { inbound, makeEngineFixture } from './engine-fixture';

const makeReference = Context.Reference;

class AcknowledgementContext extends makeReference('Test/AcknowledgementContext', {
  defaultValue: () => 'default',
}) {}

it.effect('inherits the caller context in detached acknowledgement fibers', () => {
  const acknowledged = Promise.withResolvers<string>();
  const like: LikeAcknowledgement = {
    acknowledge: () =>
      Effect.gen(function* contextualAcknowledgement() {
        acknowledged.resolve(yield* AcknowledgementContext);
      }),
    status: Effect.succeed({
      available: true,
      degraded: false,
      lastFailureAt: null,
      lastFailureReason: null,
      lastSuccessAt: null,
    }),
  };
  return Effect.gen(function* detachedAcknowledgementFixture() {
    const fixture = yield* Effect.acquireRelease(makeEngineFixture({ like }), (resource) =>
      Effect.sync(resource.remove),
    );
    fixture.push(inbound(1, 'inherit acknowledgement context'));

    yield* fixture.engine.pollOnce.pipe(Effect.provideService(AcknowledgementContext, 'inherited'));
    const value = yield* Effect.race(
      Effect.promise(() => acknowledged.promise),
      Effect.promise(() => Bun.sleep(200)).pipe(Effect.as('timed-out')),
    );
    expect(value).toBe('inherited');
  }).pipe(Effect.scoped);
});
