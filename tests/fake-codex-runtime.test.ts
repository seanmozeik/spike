import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { CodexThreadId, CodexTurnId } from '../src/domain/ids';
import { makeRuntimeHarness } from './fake-codex-runtime';

it.effect('records fake steer input only when the Effect executes', () =>
  Effect.gen(function* coldSteerTrace() {
    const { runtime, trace } = makeRuntimeHarness({}, { id: 'thread', turns: [] });
    const steer = runtime.steerTurn({
      attachments: [],
      clientUserMessageId: 'steer-attempt',
      expectedTurnId: CodexTurnId.make('turn'),
      input: 'queued',
      threadId: CodexThreadId.make('thread'),
    });

    expect(trace.steers).toStrictEqual([]);
    yield* steer;
    expect(trace.steers).toStrictEqual(['queued']);
  }),
);
