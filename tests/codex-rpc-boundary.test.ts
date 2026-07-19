import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect, Exit, Fiber, Result, Scope } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { spawnRpcHandle, type RpcHandle } from '../src/codex/rpc';
import { makeCodexRuntime } from '../src/codex/runtime';
import type { CodexLogMode } from '../src/codex/stderr-log';
import { CodexThreadId, CodexTurnId } from '../src/domain/ids';

const FAKE_CODEX_EXECUTABLE = fileURLToPath(
  new URL('fixtures/fake-codex-app-server.ts', import.meta.url),
);
const DEFAULT_TIMEOUT_MS = 1000;

interface RpcFixture {
  readonly close: () => Promise<void>;
  readonly codexHome: string;
  readonly handle: RpcHandle;
  readonly stderrLog: string;
}

interface RpcFixtureOptions {
  readonly closeHandle?: (handle: RpcHandle) => Promise<void>;
  readonly codexExecutable?: string;
  readonly logMode?: CodexLogMode;
  readonly onRootCreated?: (root: string) => void;
}

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const noOpClose = (): Promise<void> => Promise.resolve();

const withRpcFixture = async <A>(
  use: (fixture: RpcFixture) => Promise<A>,
  options: RpcFixtureOptions = {},
): Promise<A> => {
  const root = await mkdtemp(path.join(tmpdir(), 'spike-rpc-boundary-'));
  let close = noOpClose;
  try {
    options.onRootCreated?.(root);
    const codexHome = path.join(root, 'codex-home');
    const stderrLog = path.join(root, 'codex.stderr.log');
    await mkdir(codexHome, { recursive: true });
    const handle = spawnRpcHandle({
      codexExecutable: options.codexExecutable ?? FAKE_CODEX_EXECUTABLE,
      codexHome,
      logMode: options.logMode ?? 'quiet',
      stderrLog,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    let closed = false;
    close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await (options.closeHandle === undefined ? handle.close() : options.closeHandle(handle));
    };
    return await use({ close, codexHome, handle, stderrLog });
  } finally {
    try {
      await close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
};

const trackRejection = async (
  promise: Promise<unknown>,
  rejected: () => void,
): Promise<unknown> => {
  try {
    return await promise;
  } catch (error) {
    rejected();
    throw error;
  }
};

describe('Codex RPC process boundary', () => {
  it('spawns the scripted app-server with the production arguments and isolated home', async () => {
    await withRpcFixture(async ({ codexHome, handle }) => {
      await expect(handle.request('test/spawn')).resolves.toStrictEqual({
        argv: ['app-server', '--listen', 'stdio://'],
        codexHome,
      });
      await expect(handle.request('test/success', { value: 42 })).resolves.toStrictEqual({
        value: 42,
      });
      await expect(handle.request('test/error')).rejects.toStrictEqual({
        code: -32_000,
        message: 'scripted failure',
      });
    });
  });

  it('applies the quiet policy to the real child stderr stream and flushes its summary', async () => {
    await withRpcFixture(async ({ close, handle, stderrLog }) => {
      const debug = '2026-07-19T10:00:00Z DEBUG codex_core::poll: polling account state';
      const websocket =
        '2026-07-19T10:00:01Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 403 Forbidden';
      await expect(
        handle.request('test/stderr', { lines: [debug, websocket, websocket, websocket] }),
      ).resolves.toBeNull();
      await close();

      const logged = await readFile(stderrLog, 'utf8');
      expect(logged.trimEnd().split('\n')).toStrictEqual([
        websocket,
        '[warn] codex app-server repeats suppressed flow=responses-websocket-unavailable count=2',
      ]);
    });
  });

  it('retains raw diagnostics through the real child stderr stream in verbose mode', async () => {
    await withRpcFixture(
      async ({ close, handle, stderrLog }) => {
        const diagnostic = '2026-07-19T10:00:00Z DEBUG codex_core::poll: polling account state';
        await expect(
          handle.request('test/stderr', { lines: [diagnostic, diagnostic] }),
        ).resolves.toBeNull();
        await close();

        const logged = await readFile(stderrLog, 'utf8');
        expect(logged.trimEnd().split('\n')).toStrictEqual([diagnostic, diagnostic]);
      },
      { logMode: 'verbose' },
    );
  });

  it('removes its temp root when the real process spawn fails during acquisition', async () => {
    let fixtureRoot: string | undefined;
    const missingCodex = path.join(tmpdir(), `spike-missing-codex-${String(process.pid)}`);
    const acquisition = withRpcFixture(() => Promise.resolve(), {
      codexExecutable: missingCodex,
      onRootCreated: (root) => {
        fixtureRoot = root;
      },
    });
    await expect(acquisition).rejects.toThrow(/ENOENT|no such file/iu);
    if (fixtureRoot === undefined) {
      throw new Error('RPC fixture did not expose its allocated root');
    }
    expect(await pathExists(fixtureRoot)).toBe(false);
  });

  it('removes its exact temp root when process close fails', async () => {
    let fixtureRoot: string | undefined;
    const closing = withRpcFixture(() => Promise.resolve(), {
      closeHandle: async (handle) => {
        await handle.close();
        throw new Error('scripted close failure');
      },
      onRootCreated: (root) => {
        fixtureRoot = root;
      },
    });
    await expect(closing).rejects.toThrow('scripted close failure');
    if (fixtureRoot === undefined) {
      throw new Error('RPC fixture did not expose its allocated root');
    }
    expect(await pathExists(fixtureRoot)).toBe(false);
  });

  it('decodes split frames and multiple frames written together', async () => {
    await withRpcFixture(async ({ handle }) => {
      await expect(handle.request('test/split')).resolves.toBe('split');
      const [first, second] = await Promise.all([
        handle.request('test/batch', { batch: 1 }),
        handle.request('test/batch', { batch: 2 }),
      ]);
      expect(first).toStrictEqual({ batch: 1 });
      expect(second).toStrictEqual({ batch: 2 });
    });
  });

  it('ignores malformed and orphan response frames without losing the live request', async () => {
    await withRpcFixture(async ({ handle }) => {
      await expect(handle.request('test/noise')).resolves.toBe('after-noise');
      await expect(handle.request('test/success', 'still-alive')).resolves.toBe('still-alive');
    });
  });

  it('routes the frame after a timed-out request and ignores that request’s late response', async () => {
    await withRpcFixture(async ({ handle }) => {
      let lateFrame: unknown;
      const remove = handle.addNotificationListener((notification) => {
        if (notification.method === 'test/late-frame-written') {
          lateFrame = notification.params;
        }
      });
      try {
        await expect(handle.request('test/late', undefined, 10)).rejects.toThrow(
          'test/late#1 timed out after 10ms',
        );
        await vi.waitFor(() => {
          expect(lateFrame).toStrictEqual({ requestId: 1 });
        });
      } finally {
        remove();
      }
    });
  });

  it('fails a real runtime turn wait promptly when its child dies', async () => {
    await withRpcFixture(async ({ handle }) => {
      const runtime = makeCodexRuntime(handle, 'prompt', 'default', '/workspace');
      const scope = await Effect.runPromise(Scope.make());
      const threadId = CodexThreadId.make('thread');
      const turnId = CodexTurnId.make('turn');
      const turnWait = runtime.waitForTurn(threadId, turnId, {
        onAcknowledgement: (): void => undefined,
        onCompactionStarted: (): void => undefined,
      });
      const fiber = await Effect.runPromise(
        Effect.forkIn(turnWait, scope, { startImmediately: true }),
      );
      let childClosed = false;
      const removeCloseListener = handle.addConnectionCloseListener(() => {
        childClosed = true;
      });
      try {
        await expect(handle.request('test/exit')).rejects.toThrow('exited with 17');
        await vi.waitFor(() => {
          expect(childClosed).toBe(true);
          expect(fiber.pollUnsafe()).toBeDefined();
        });
        const result = await Effect.runPromise(Effect.result(Fiber.join(fiber)));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ operation: 'turn/wait' });
          expect(String(result.failure)).toContain('app-server connection closed');
        }
      } finally {
        removeCloseListener();
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
    });
  });

  it('rejects every pending request once when the child exits and publishes close once', async () => {
    await withRpcFixture(async ({ close, handle }) => {
      let hangObserved = 0;
      let retainedListenerCalls = 0;
      let removedListenerCalls = 0;
      let rejectionCalls = 0;
      handle.addNotificationListener((notification) => {
        if (notification.method === 'test/hang-observed') {
          hangObserved += 1;
        }
      });
      const remove = handle.addConnectionCloseListener(() => {
        removedListenerCalls += 1;
      });
      remove();
      handle.addConnectionCloseListener(() => {
        retainedListenerCalls += 1;
      });
      const hanging = trackRejection(handle.request('test/hang'), () => {
        rejectionCalls += 1;
      });
      await vi.waitFor(() => {
        expect(hangObserved).toBe(1);
      });
      const exiting = trackRejection(handle.request('test/exit'), () => {
        rejectionCalls += 1;
      });
      const settled = await Promise.allSettled([hanging, exiting]);
      expect(settled.every(({ status }) => status === 'rejected')).toBe(true);
      expect(
        settled.every(
          (result) =>
            result.status === 'rejected' && String(result.reason).includes('exited with 17'),
        ),
      ).toBe(true);
      expect(rejectionCalls).toBe(2);
      expect(retainedListenerCalls).toBe(1);
      expect(removedListenerCalls).toBe(0);
      let lateListenerCalls = 0;
      handle.addConnectionCloseListener(() => {
        lateListenerCalls += 1;
      });
      await vi.waitFor(() => {
        expect(lateListenerCalls).toBe(1);
      });
      await close();
      expect(retainedListenerCalls).toBe(1);
      await expect(handle.request('test/success')).rejects.toThrow('already exited');
    });
  });

  it('rejects all pending requests on explicit close and honors listener removal', async () => {
    await withRpcFixture(async ({ close, handle }) => {
      let hangObserved = 0;
      let rejectionCalls = 0;
      let retainedListenerCalls = 0;
      let removedListenerCalls = 0;
      handle.addNotificationListener((notification) => {
        if (notification.method === 'test/hang-observed') {
          hangObserved += 1;
        }
      });
      handle.addConnectionCloseListener(() => {
        retainedListenerCalls += 1;
      });
      const remove = handle.addConnectionCloseListener(() => {
        removedListenerCalls += 1;
      });
      remove();
      const pending = [
        trackRejection(handle.request('test/hang'), () => {
          rejectionCalls += 1;
        }),
        trackRejection(handle.request('test/hang'), () => {
          rejectionCalls += 1;
        }),
      ];
      await vi.waitFor(() => {
        expect(hangObserved).toBe(2);
      });
      const settlement = Promise.allSettled(pending);
      await close();
      const settled = await settlement;
      expect(settled.every(({ status }) => status === 'rejected')).toBe(true);
      expect(
        settled.every(
          (result) => result.status === 'rejected' && String(result.reason).includes('closed'),
        ),
      ).toBe(true);
      expect(rejectionCalls).toBe(2);
      expect(retainedListenerCalls).toBe(1);
      expect(removedListenerCalls).toBe(0);
      await close();
      expect(retainedListenerCalls).toBe(1);
    });
  });
});
