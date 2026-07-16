import { it } from '@effect/vitest';
import { Effect, Fiber, Result } from 'effect';
import { expect, vi } from 'vitest';

import type { JsonRpcNotification, RpcHandle } from '../src/codex/rpc';
import { makeCodexRuntime } from '../src/codex/runtime';
import { CodexThreadId, CodexTurnId } from '../src/domain/ids';
import { isGenerationBroken } from '../src/errors';

interface RequestRecord {
  readonly method: string;
  readonly params: unknown;
  readonly timeoutMs: number | undefined;
}

interface FakeHandle {
  readonly emit: (notification: JsonRpcNotification) => void;
  readonly handle: RpcHandle;
  readonly requests: RequestRecord[];
}

const makeHandle = (missingThread = false, unloadedThread = false): FakeHandle => {
  const listeners: ((notification: JsonRpcNotification) => void)[] = [];
  const requests: RequestRecord[] = [];
  let threadReads = 0;
  const handle: RpcHandle = {
    addNotificationListener: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      };
    },
    close: () => Promise.resolve(),
    notify: () => Promise.resolve(),
    request: (method, params, timeoutMs) => {
      requests.push({ method, params, timeoutMs });
      if (missingThread && (method === 'thread/resume' || method === 'thread/read')) {
        const error = new Error('no rollout found for thread id thread-missing');
        Object.assign(error, { code: -32_600 });
        return Promise.reject(error);
      }
      if (unloadedThread && method === 'thread/read' && threadReads === 0) {
        threadReads += 1;
        const error = new Error('thread not loaded: thread');
        Object.assign(error, { code: -32_600 });
        return Promise.reject(error);
      }
      if (method === 'thread/loaded/list') {
        return Promise.resolve({ data: [], nextCursor: null });
      }
      if (method === 'thread/start') {
        return Promise.resolve({ thread: { id: 'thread' } });
      }
      if (method === 'turn/start') {
        return Promise.resolve({ turn: { id: 'turn' } });
      }
      if (method === 'thread/read') {
        return Promise.resolve({ thread: { id: 'thread', turns: [] } });
      }
      return Promise.resolve({});
    },
  };
  return {
    emit: (notification: JsonRpcNotification): void => {
      for (const listener of listeners) {
        listener(notification);
      }
    },
    handle,
    requests,
  };
};

it.effect('classifies a missing persisted rollout as a broken generation', () =>
  Effect.gen(function* missingRollout() {
    const fake = makeHandle(true);
    const runtime = makeCodexRuntime(fake.handle, 'prompt', 'default', '/workspace');
    const threadId = CodexThreadId.make('thread-missing');
    const resume = yield* Effect.result(runtime.resumeThread(threadId));
    const read = yield* Effect.result(runtime.readThread(threadId));
    expect(Result.isFailure(resume) && isGenerationBroken(resume.failure)).toBe(true);
    expect(Result.isFailure(read) && isGenerationBroken(read.failure)).toBe(true);
  }),
);

it.effect('resumes and retries one read when the rollout exists but is not loaded', () =>
  Effect.gen(function* unloadedThread() {
    const fakeHandle = makeHandle(false, true);
    const codexRuntime = makeCodexRuntime(fakeHandle.handle, 'prompt', 'default', '/workspace');
    expect(yield* codexRuntime.readThread(CodexThreadId.make('thread'))).toEqual({
      id: 'thread',
      turns: [],
    });
    expect(fakeHandle.requests.map(({ method }) => method)).toEqual([
      'thread/read',
      'thread/resume',
      'thread/read',
    ]);
  }),
);

it.effect('uses the schema-shaped loaded-thread request and response', () =>
  Effect.gen(function* loadedThreads() {
    const fake = makeHandle();
    const runtime = makeCodexRuntime(fake.handle, 'prompt', 'default', '/workspace');
    expect(yield* runtime.loadedThreads).toStrictEqual([]);
    expect(fake.requests).toContainEqual({
      method: 'thread/loaded/list',
      params: {},
      timeoutMs: undefined,
    });
  }),
);

it.effect('fails a turn whose completion notification never arrives', () =>
  Effect.gen(function* boundedTurnWait() {
    vi.useFakeTimers();
    const fake = makeHandle();
    const runtime = makeCodexRuntime(fake.handle, 'prompt', 'default', '/workspace');
    const acknowledgements: string[] = [];
    const fiber = yield* Effect.forkChild(
      runtime.waitForTurn(CodexThreadId.make('thread'), CodexTurnId.make('turn'), {
        onAcknowledgement: (text): void => {
          acknowledgements.push(text);
        },
        onCompactionStarted: (): void => undefined,
      }),
    );
    vi.advanceTimersByTime(60 * 60 * 1000);
    const result = yield* Effect.result(Fiber.join(fiber));
    vi.useRealTimers();
    expect(Result.isFailure(result)).toBe(true);
  }),
);

it.effect('starts the isolated configured thread and sends xhigh Fast turns and steers', () =>
  Effect.gen(function* runtimeFixture() {
    const fake = makeHandle();
    const runtime = makeCodexRuntime(fake.handle, 'Spike prompt', 'default', '/workspace');
    const threadId = yield* runtime.startThread;
    expect(threadId).toBe('thread');
    const turnId = yield* runtime.startTurn({
      clientUserMessageId: 'attempt',
      input: 'hello',
      threadId,
    });

    yield* runtime.steerTurn({
      clientUserMessageId: 'steer-attempt',
      expectedTurnId: turnId,
      input: 'also this',
      threadId,
    });
    yield* runtime.interruptTurn(threadId, turnId);
    yield* runtime.archiveThread(threadId);
    expect(fake.requests).toMatchObject([
      { method: 'thread/start', params: { baseInstructions: 'Spike prompt', cwd: '/workspace' } },
      { method: 'turn/start', params: { clientUserMessageId: 'attempt' } },
      {
        method: 'turn/steer',
        params: { clientUserMessageId: 'steer-attempt', expectedTurnId: 'turn' },
      },
      { method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn' } },
      { method: 'thread/archive', params: { threadId: 'thread' } },
    ]);
  }),
);

it.effect('uses a fast local health probe and a bounded remote rate-limit read', () =>
  Effect.gen(function* statusFixture() {
    const fake = makeHandle();
    const runtime = makeCodexRuntime(fake.handle, 'prompt', 'default', '/workspace');
    yield* runtime.health;
    yield* runtime.rateLimits;
    expect(fake.requests).toContainEqual({
      method: 'account/read',
      params: { refreshToken: false },
      timeoutMs: 700,
    });
    expect(fake.requests).toContainEqual({
      method: 'account/rateLimits/read',
      params: undefined,
      timeoutMs: 2000,
    });
  }),
);

it.effect('emits one acknowledgement and releases the final only after successful completion', () =>
  Effect.gen(function* outputFixture() {
    const fake = makeHandle();
    const runtime = makeCodexRuntime(fake.handle, 'prompt', 'default', '/workspace');
    const acknowledgements: string[] = [];
    const compactions: string[] = [];
    const fiber = yield* Effect.forkChild(
      runtime.waitForTurn(CodexThreadId.make('thread'), CodexTurnId.make('turn'), {
        onAcknowledgement: (text) => {
          acknowledgements.push(text);
        },
        onCompactionStarted: (itemId) => {
          compactions.push(itemId);
        },
      }),
    );
    yield* Effect.promise(() => Bun.sleep(1));
    const compactionNotification = {
      method: 'item/started',
      params: {
        item: { id: 'compact-1', type: 'contextCompaction' },
        threadId: 'thread',
        turnId: 'turn',
      },
    };
    fake.emit(compactionNotification);
    fake.emit(compactionNotification);
    fake.emit({
      method: 'item/completed',
      params: {
        item: { id: 'ack', phase: 'commentary', text: 'Looking into it now', type: 'agentMessage' },
        threadId: 'thread',
        turnId: 'turn',
      },
    });
    fake.emit({
      method: 'item/completed',
      params: {
        item: { id: 'final', phase: 'final_answer', text: 'Done.', type: 'agentMessage' },
        threadId: 'thread',
        turnId: 'turn',
      },
    });
    fake.emit({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
    });
    expect(yield* Fiber.join(fiber)).toEqual({
      acknowledgement: 'Looking into it now',
      finalAnswer: 'Done.',
    });
    expect(acknowledgements).toEqual(['Looking into it now']);
    expect(compactions).toEqual(['compact-1']);
  }),
);
