import { it } from '@effect/vitest';
import { Deferred, Effect } from 'effect';
import { expect, it as vitestIt } from 'vitest';

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
  configurationCurrent: true,
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
  message: { attachments: [], id: InboundMessageId.make(id), receivedAt: new Date(at), text: id },
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

it.effect('re-arms a persisted pool once only after explicit activation', () =>
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
    const controller = yield* makeSchedulerController(
      {
        ...initial,
        active: {
          acknowledged: false,
          codexTurnId: CodexTurnId.make('codex-turn'),
          logicalTurnId: LogicalTurnId.make('turn-1'),
        },
        pool: [
          {
            attachments: [],
            id: InboundMessageId.make('pooled'),
            receivedAt: pooledAt,
            text: 'still waiting',
          },
        ],
      },
      journal(),
      ports,
    );
    expect(deadlines).toStrictEqual([]);
    yield* controller.activate;
    yield* controller.activate;
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
      message: {
        attachments: [],
        id: InboundMessageId.make('new-command'),
        receivedAt: new Date(),
        text: '/new',
      },
      newGenerationId: GenerationId.make('generation-2'),
      nextLogicalTurnId: LogicalTurnId.make('unused'),
    });
    expect(replies).toEqual(['NewChat']);
    expect(failures).toHaveLength(1);
    expect((yield* controller.snapshot).codexThreadId).toBe('fresh-thread');
  }),
);

vitestIt('/new waits for an owned turn-notice critical section', async () => {
  await Effect.runPromise(
    Effect.gen(function* serializedTurnNotice() {
      const started = yield* Deferred.make<boolean>();
      const order: string[] = [];
      const active = {
        ...initial,
        active: {
          acknowledged: false,
          codexTurnId: CodexTurnId.make('codex-turn'),
          logicalTurnId: LogicalTurnId.make('turn-1'),
        },
      } satisfies SchedulerState;
      const ports: SchedulerPorts = {
        bindThread: (): Effect.Effect<null> => Effect.succeed(null),
        cleanupGeneration: (): Effect.Effect<void> => Effect.void,
        replyLocal: (): Effect.Effect<void> => Effect.void,
        reportFailure: (): Effect.Effect<void> => Effect.void,
        schedulePool: (): Effect.Effect<void> => Effect.void,
        startTurn: () =>
          Effect.succeed({
            threadId: CodexThreadId.make('thread'),
            turnId: CodexTurnId.make('codex-turn'),
          }),
        steerTurn: (): Effect.Effect<void> => Effect.void,
      };
      const guardedJournal: SchedulerJournal = {
        ...journal(),
        commitTransition: (transition): Effect.Effect<void> =>
          Effect.sync(() => {
            if (transition.actions.some(({ kind }) => kind === 'ResetGeneration')) {
              order.push('reset');
            }
          }),
      };
      const controller = yield* makeSchedulerController(active, guardedJournal, ports);
      const notice = controller.runIfTurnOwned(
        { generationId: active.generationId, logicalTurnId: active.active.logicalTurnId },
        Effect.gen(function* heldNotice() {
          order.push('notice-start');
          yield* Deferred.succeed(started, true);
          yield* Effect.yieldNow;
          order.push('notice-end');
        }),
      );
      const reset = Effect.gen(function* resetAfterNoticeStarts() {
        yield* Deferred.await(started);
        yield* controller.dispatch({
          kind: 'Inbound',
          message: {
            attachments: [],
            id: InboundMessageId.make('new-command'),
            receivedAt: new Date(),
            text: '/new',
          },
          newGenerationId: GenerationId.make('generation-2'),
          nextLogicalTurnId: LogicalTurnId.make('unused'),
        });
      });
      yield* Effect.all([notice, reset], { concurrency: 'unbounded', discard: true });

      expect(order).toEqual(['notice-start', 'notice-end', 'reset']);
      expect((yield* controller.snapshot).generationId).toBe('generation-2');
    }),
  );
});
