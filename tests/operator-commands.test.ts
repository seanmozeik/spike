import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { afterEach, expect, vi } from 'vitest';

import { makeLiveOperatorCommands } from '../src/operator/commands';

const processResult = (
  exitCode: number,
  stdout: string,
  stderr: string,
  timedOut = false,
): Bun.ReadableSyncSubprocess => ({
  ...(timedOut ? { exitedDueToTimeout: true, signalCode: 'SIGKILL' } : {}),
  exitCode,
  pid: 42,
  resourceUsage: {
    contextSwitches: { involuntary: 0, voluntary: 0 },
    cpuTime: { system: 0, total: 0, user: 0 },
    maxRSS: 0,
    messages: { received: 0, sent: 0 },
    ops: { in: 0, out: 0 },
    shmSize: 0,
    signalCount: 0,
    swapCount: 0,
  },
  stderr: Buffer.from(stderr),
  stdout: Buffer.from(stdout),
  success: exitCode === 0,
});

afterEach(() => {
  vi.restoreAllMocks();
});

it.effect('runs the exact bounded launchctl argv and maps process output', () =>
  Effect.gen(function* launchctlBoundary() {
    const spawn = vi
      .spyOn(Bun, 'spawnSync')
      .mockImplementation(() => processResult(7, 'service output', 'permission denied'));

    const result = yield* makeLiveOperatorCommands().launchctl([
      'print',
      'gui/501/com.mozeik.spike',
    ]);

    expect(spawn).toHaveBeenCalledWith(['launchctl', 'print', 'gui/501/com.mozeik.spike'], {
      stderr: 'pipe',
      stdout: 'pipe',
      timeout: 10_000,
    });
    expect(result).toEqual({
      exitCode: 7,
      signalCode: null,
      stderr: 'permission denied',
      stdout: 'service output',
      timedOut: false,
    });
  }),
);

it.effect('preserves process timeout and signal metadata', () =>
  Effect.gen(function* launchctlTimeout() {
    vi.spyOn(Bun, 'spawnSync').mockImplementation(() => processResult(1, '', '', true));

    const result = yield* makeLiveOperatorCommands().launchctl([
      'print',
      'gui/501/com.mozeik.spike',
    ]);

    expect(result).toEqual({
      exitCode: 1,
      signalCode: 'SIGKILL',
      stderr: '',
      stdout: '',
      timedOut: true,
    });
  }),
);

it.effect('preserves thrown spawn failures with their launchctl argv', () =>
  Effect.gen(function* launchctlSpawnFailure() {
    vi.spyOn(Bun, 'spawnSync').mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const result = yield* Effect.result(
      makeLiveOperatorCommands().launchctl(['bootout', 'gui/501/com.mozeik.spike']),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        message: 'spawn failed',
        operation: 'operator/launchctl',
      });
      expect(result.failure.cause).toMatchObject({
        argv: ['launchctl', 'bootout', 'gui/501/com.mozeik.spike'],
        cause: new Error('spawn failed'),
      });
    }
  }),
);
