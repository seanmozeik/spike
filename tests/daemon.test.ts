import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { afterEach, expect, vi } from 'vitest';

import { requestControl, startControlSocket } from '../src/control-socket';
import { serveDaemon } from '../src/daemon';
import { spikePaths } from '../src/paths';
import { isDoctorReport } from '../src/status/doctor';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('serves status and releases the journal and socket on control shutdown', () =>
  Effect.gen(function* daemonFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-daemon-'));
    roots.push(root);
    const paths = spikePaths(root);
    const fiber = yield* Effect.forkChild(serveDaemon(paths, { codex: false }));
    for (let attempt = 0; attempt < 50 && !existsSync(paths.socket); attempt += 1) {
      yield* Effect.promise(() => Bun.sleep(10));
    }
    expect(existsSync(paths.socket)).toBe(true);
    const status = yield* Effect.promise(() => requestControl(paths.socket, { kind: 'status' }));
    expect(status).toMatchObject({
      appServer: { healthy: false },
      ok: true,
      service: { healthy: true },
      turn: { pooledMessages: 0, state: 'idle' },
    });
    const doctor = yield* Effect.promise(() => requestControl(paths.socket, { kind: 'doctor' }));
    expect(isDoctorReport(doctor)).toBe(true);
    const shutdown = yield* Effect.promise(() =>
      requestControl(paths.socket, { kind: 'shutdown' }),
    );
    expect(shutdown).toStrictEqual({ ok: true, stopping: true });
    yield* Fiber.join(fiber);
    expect(existsSync(paths.socket)).toBe(false);
  }),
);

it.effect('allows slow diagnostic responses to use an explicit response budget', () =>
  Effect.gen(function* slowDoctorFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-control-'));
    roots.push(root);
    const paths = spikePaths(root);
    mkdirSync(path.dirname(paths.socket), { recursive: true });
    const shutdown = vi.fn();
    const server = yield* Effect.promise(() =>
      startControlSocket(
        paths,
        new Date().toISOString(),
        () => {
          shutdown();
        },
        undefined,
        async () => {
          await Bun.sleep(30);
          return { checks: [], healthy: true, ok: true };
        },
      ),
    );
    const report = yield* Effect.promise(() =>
      requestControl(paths.socket, { kind: 'doctor' }, { timeoutMs: 100 }),
    );
    expect(report).toStrictEqual({ checks: [], healthy: true, ok: true });
    expect(shutdown).not.toHaveBeenCalled();
    server.close();
  }),
);
