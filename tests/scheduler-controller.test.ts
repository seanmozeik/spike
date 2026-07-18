import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import {
  CodexThreadId,
  CodexTurnId,
  GenerationId,
  InboundMessageId,
  LogicalTurnId,
} from '../src/domain/ids';
import { SpikeRuntimeError } from '../src/errors';
import type { SchedulerJournal } from '../src/journal/scheduler-journal';
import { makeSchedulerController, type SchedulerPorts } from '../src/scheduler/controller';
import type { SchedulerEvent, SchedulerState } from '../src/scheduler/model';

const initial: SchedulerState = {
  active: null,
  codexThreadId: null,
  generationBroken: false,
  generationId: GenerationId.make('generation'),
  pool: [],
};

const journal = (): SchedulerJournal => ({
  commitTransition: (): Effect.Effect<void> => Effect.void,
  loadInputBatches: (): Effect.Effect<readonly []> => Effect.succeed([]),
  loadOrCreate: (): Effect.Effect<SchedulerState> => Effect.succeed(initial),
});

const inbound = (id: string, at: number, logicalTurnId: string): SchedulerEvent => ({
  kind: 'Inbound',
  message: { id: InboundMessageId.make(id), receivedAt: new Date(at), text: id },
  newGenerationId: GenerationId.make(`generation-${id}`),
  nextLogicalTurnId: LogicalTurnId.make(logicalTurnId),
});

it.effect('serializes concurrent inbound events and never starts two turns', () =>
  Effect.gen(function* controllerFixture() {
    let starts = 0;
    const deadlines: Date[] = [];
    const ports: SchedulerPorts = {
      bindThread: (): Effect.Effect<null> => Effect.succeed(null),
      cleanupGeneration: (): Effect.Effect<void> => Effect.void,
      replyLocal: (): Effect.Effect<void> => Effect.void,
      reportFailure: (): Effect.Effect<void> => Effect.void,
      schedulePool: (deadlineAt): Effect.Effect<void> =>
        Effect.sync(() => {
          deadlines.push(deadlineAt);
        }),
      startTurn: () =>
        Effect.sync(() => {
          starts += 1;
          return { threadId: CodexThreadId.make('thread'), turnId: CodexTurnId.make('codex-turn') };
        }),
      steerTurn: (): Effect.Effect<void> => Effect.void,
    };
    const controller = yield* makeSchedulerController(initial, journal(), ports);
    yield* Effect.all(
      [
        controller.dispatch(inbound('first', 0, 'turn-1')),
        controller.dispatch(inbound('second', 1, 'turn-2')),
      ],
      { concurrency: 'unbounded' },
    );
    expect(starts).toBe(1);
    expect(deadlines).toHaveLength(1);
    expect((yield* controller.snapshot).active?.logicalTurnId).toBe('turn-1');
    expect((yield* controller.snapshot).pool.map(({ id }) => id)).toEqual(['second']);
  }),
);

it.effect('re-arms a persisted pool when the controller restarts', () =>
  Effect.gen(function* restartFixture() {
    const deadlines: Date[] = [];
    const pooledAt = new Date('2026-07-14T18:00:00Z');
    const ports: SchedulerPorts = {
      bindThread: (): Effect.Effect<null> => Effect.succeed(null),
      cleanupGeneration: (): Effect.Effect<void> => Effect.void,
      replyLocal: (): Effect.Effect<void> => Effect.void,
      reportFailure: (): Effect.Effect<void> => Effect.void,
      schedulePool: (deadlineAt): Effect.Effect<void> =>
        Effect.sync(() => {
          deadlines.push(deadlineAt);
        }),
      startTurn: () =>
        Effect.succeed({
          threadId: CodexThreadId.make('thread'),
          turnId: CodexTurnId.make('codex-turn'),
        }),
      steerTurn: (): Effect.Effect<void> => Effect.void,
    };
    yield* makeSchedulerController(
      {
        ...initial,
        active: {
          acknowledged: false,
          codexTurnId: CodexTurnId.make('codex-turn'),
          logicalTurnId: LogicalTurnId.make('turn-1'),
        },
        pool: [
          { id: InboundMessageId.make('pooled'), receivedAt: pooledAt, text: 'still waiting' },
        ],
      },
      journal(),
      ports,
    );
    expect(deadlines).toEqual([new Date(pooledAt.getTime() + 3000)]);
  }),
);

it.effect('/new binds a ready thread and replies even when old-thread cleanup fails', () =>
  Effect.gen(function* newChatFixture() {
    const replies: string[] = [];
    const failures: unknown[] = [];
    const ports: SchedulerPorts = {
      bindThread: () => Effect.succeed(CodexThreadId.make('fresh-thread')),
      cleanupGeneration: () =>
        Effect.fail(
          new SpikeRuntimeError({
            cause: new Error('archive failed'),
            message: 'archive failed',
            operation: 'thread/archive',
          }),
        ),
      replyLocal: (kind): Effect.Effect<void> =>
        Effect.sync(() => {
          replies.push(kind);
        }),
      reportFailure: (error): Effect.Effect<void> =>
        Effect.sync(() => {
          failures.push(error);
        }),
      schedulePool: (): Effect.Effect<void> => Effect.void,
      startTurn: () =>
        Effect.succeed({
          threadId: CodexThreadId.make('fresh-thread'),
          turnId: CodexTurnId.make('unused'),
        }),
      steerTurn: (): Effect.Effect<void> => Effect.void,
    };
    const controller = yield* makeSchedulerController(initial, journal(), ports);
    yield* controller.dispatch({
      kind: 'Inbound',
      message: { id: InboundMessageId.make('new-command'), receivedAt: new Date(), text: '/new' },
      newGenerationId: GenerationId.make('generation-2'),
      nextLogicalTurnId: LogicalTurnId.make('unused'),
    });
    expect(replies).toEqual(['NewChat']);
    expect(failures).toHaveLength(1);
    expect((yield* controller.snapshot).codexThreadId).toBe('fresh-thread');
  }),
);
