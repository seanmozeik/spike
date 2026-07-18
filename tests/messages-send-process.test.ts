import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { it } from '@effect/vitest';
import { Effect, Fiber, Result } from 'effect';
import { expect } from 'vitest';

import { MessagesDeliveryError } from '../src/delivery/error';
import { makeMessagesTransport, type MessagesTransport } from '../src/delivery/messages-transport';
import { makeOsascriptSendBoundary } from '../src/delivery/osascript-send';
import { TEST_CHAT_GUID, type MessagesFixture, withMessagesFixture } from './messages-fixture';

const FAKE_OSASCRIPT = fileURLToPath(new URL('fixtures/fake-osascript.ts', import.meta.url));
const FAKE_COMMAND = [process.execPath, FAKE_OSASCRIPT] as const;
const TEST_TIMEOUT_MS = 300;
const TEST_TERMINATION_GRACE_MS = 100;
const MAX_TIMEOUT_OVERHEAD_MS = 1000;
const FILE_POLL_MS = 5;
const FILE_POLL_ATTEMPTS = 100;

const instruction = (mode: string, root?: string): string =>
  root === undefined ? mode : `${mode}\t${root}`;

const waitForFile = async (filePath: string, attempts = FILE_POLL_ATTEMPTS): Promise<void> => {
  if (await Bun.file(filePath).exists()) {
    return;
  }
  if (attempts === 0) {
    throw new Error(`fixture marker was not created: ${filePath}`);
  }
  await Bun.sleep(FILE_POLL_MS);
  return waitForFile(filePath, attempts - 1);
};

const failureCauseMessage = (error: MessagesDeliveryError): string =>
  error.cause instanceof Error ? error.cause.message : String(error.cause);

const makeTestTransport = (messages: MessagesFixture): MessagesTransport =>
  makeMessagesTransport(
    messages.database,
    TEST_CHAT_GUID,
    makeOsascriptSendBoundary({
      command: FAKE_COMMAND,
      terminationGraceMs: TEST_TERMINATION_GRACE_MS,
      timeoutMs: TEST_TIMEOUT_MS,
    }),
  );

const readFixturePid = async (root: string): Promise<number> =>
  Number(await Bun.file(path.join(root, 'pid')).text());

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.effect('sends through the asynchronous osascript process boundary', () =>
  withMessagesFixture((messages) => {
    const transport = makeTestTransport(messages);
    return transport.send(instruction('success'));
  }),
);

it.effect('maps nonzero osascript stderr through MessagesDeliveryError', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* nonzeroExitFixture() {
      const transport = makeTestTransport(messages);
      const result = yield* Effect.result(transport.send(instruction('failure')));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(MessagesDeliveryError);
        expect(result.failure.operation).toBe('send');
        expect(failureCauseMessage(result.failure)).toBe('scripted osascript failure');
      }
    }),
  ),
);

it.effect('fails a hung osascript send at the configured deadline', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* timeoutFixture() {
      const transport = makeTestTransport(messages);
      const result = yield* Effect.result(transport.send(instruction('hang', messages.root)));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.operation).toBe('send');
        expect(failureCauseMessage(result.failure)).toBe(
          `osascript send timed out after ${TEST_TIMEOUT_MS}ms`,
        );
      }
    }),
  ),
);

it.effect('kills and reaps the child before returning a timeout failure', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* cleanupFixture() {
      const transport = makeTestTransport(messages);
      const result = yield* Effect.result(transport.send(instruction('hang', messages.root)));
      expect(Result.isFailure(result)).toBe(true);
      expect(
        yield* Effect.promise(() => Bun.file(path.join(messages.root, 'started')).exists()),
      ).toBe(true);
      expect(
        yield* Effect.promise(() => Bun.file(path.join(messages.root, 'terminated')).exists()),
      ).toBe(true);
    }),
  ),
);

it.effect('keeps timers and transport control work responsive while osascript is pending', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* responsiveFixture() {
      const transport = makeTestTransport(messages);
      const send = yield* transport
        .send(instruction('hang', messages.root))
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => waitForFile(path.join(messages.root, 'started')));
      let timerFired = false;
      setTimeout(() => {
        timerFired = true;
      }, 0);
      yield* Effect.promise(() => Bun.sleep(FILE_POLL_MS));
      expect(timerFired).toBe(true);
      expect(yield* transport.frontier).toBe(0);
      expect(Result.isFailure(yield* Fiber.join(send))).toBe(true);
    }),
  ),
);

it.effect('SIGKILLs and reaps a child that ignores SIGTERM within the bounded grace period', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* ignoredTerminationFixture() {
      const transport = makeTestTransport(messages);
      const startedAt = performance.now();
      const result = yield* Effect.result(
        transport.send(instruction('ignore-term', messages.root)),
      );
      const elapsedMs = performance.now() - startedAt;
      expect(Result.isFailure(result)).toBe(true);
      expect(elapsedMs).toBeLessThan(
        TEST_TIMEOUT_MS + TEST_TERMINATION_GRACE_MS + MAX_TIMEOUT_OVERHEAD_MS,
      );
      expect(
        yield* Effect.promise(() => Bun.file(path.join(messages.root, 'term-received')).exists()),
      ).toBe(true);
      const pid = yield* Effect.promise(() => readFixturePid(messages.root));
      expect(processIsRunning(pid)).toBe(false);
    }),
  ),
);

it.effect('hard-kills and reaps the osascript child before fiber interruption completes', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* interruptedSendFixture() {
      const transport = makeTestTransport(messages);
      const send = yield* transport
        .send(instruction('ignore-term', messages.root))
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => waitForFile(path.join(messages.root, 'started')));
      const pid = yield* Effect.promise(() => readFixturePid(messages.root));
      yield* Fiber.interrupt(send);
      expect(processIsRunning(pid)).toBe(false);
    }),
  ),
);
