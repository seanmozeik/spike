import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
  recordedCommands,
  runCommand,
  runObservedCommand,
} from '../scripts/package-validation-command';

const FILE_POLL_INTERVAL_MS = 10;
const FIXTURE_READY_ATTEMPTS = 100;
const ESCAPED_COMMAND_TIMEOUT_MS = 2000;
const MAX_TIMEOUT_OVERHEAD_MS = 1000;
const COMPLETE_PID_MARKER = /^[1-9]\d*\n$/u;

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH') {
      return false;
    }
    throw error;
  }
};

const waitForProcessExit = async (pid: number, attempts: number): Promise<boolean> => {
  if (!processExists(pid)) {
    return true;
  }
  if (attempts === 0) {
    return false;
  }
  await Bun.sleep(10);
  return waitForProcessExit(pid, attempts - 1);
};

const readFixturePid = async (pidFile: string): Promise<number | undefined> => {
  const marker = Bun.file(pidFile);
  if (!(await marker.exists())) {
    return undefined;
  }
  const contents = await marker.text();
  if (!COMPLETE_PID_MARKER.test(contents)) {
    return undefined;
  }
  const pid = Number(contents.slice(0, -1));
  return Number.isSafeInteger(pid) ? pid : undefined;
};

const waitForFixturePid = async (
  pidFile: string,
  attempts = FIXTURE_READY_ATTEMPTS,
): Promise<number> => {
  const pid = await readFixturePid(pidFile);
  if (pid !== undefined) {
    return pid;
  }
  if (attempts === 0) {
    throw new Error(`fixture PID marker was not ready: ${pidFile}`);
  }
  await Bun.sleep(FILE_POLL_INTERVAL_MS);
  return waitForFixturePid(pidFile, attempts - 1);
};

it('reads only complete positive fixture PID markers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spike-command-pid-marker-'));
  const pidFile = path.join(root, 'descendant.pid');
  try {
    await Bun.write(pidFile, '42');
    expect(await readFixturePid(pidFile)).toBeUndefined();
    await Bun.write(pidFile, '42\n');
    expect(await readFixturePid(pidFile)).toBe(42);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('bounds commands that leave descendants holding their output pipes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spike-command-timeout-'));
  const pidFile = path.join(root, 'descendant.pid');
  const startedAt = performance.now();
  try {
    const command = 'sleep 10 & child=$!; printf "%s" "$child" > "$1"; wait "$child"';
    await expect(
      runCommand({
        argv: ['/bin/sh', '-c', command, 'timeout-probe', pidFile],
        cwd: root,
        environment: { PATH: '/usr/bin:/bin' },
        label: 'process group timeout probe',
        timeoutMs: 100,
      }),
    ).rejects.toThrow('process group timeout probe exceeded its 100ms timeout');
    expect(performance.now() - startedAt).toBeLessThan(1000);

    const descendantPid = Number(await readFile(pidFile, 'utf8'));
    expect(await waitForProcessExit(descendantPid, 20)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('records observed commands and bounds graceful process-group shutdown', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spike-command-observed-'));
  const pidFile = path.join(root, 'descendant.pid');
  try {
    const command = `trap 'exit 0' TERM; sleep 10 & child=$!; printf "%s" "$child" > "$1"; wait "$child"`;
    const result = await runObservedCommand({
      argv: ['/bin/sh', '-c', command, 'observed-probe', pidFile],
      cwd: root,
      environment: { PATH: '/usr/bin:/bin' },
      label: 'observed process group probe',
      observe: async ({ isRunning }) => {
        await Bun.sleep(25);
        expect(isRunning()).toBe(true);
      },
      shutdownGraceMs: 100,
      timeoutMs: 1000,
    });
    expect(result.exitCode).toBe(0);
    const descendantPid = Number(await readFile(pidFile, 'utf8'));
    expect(await waitForProcessExit(descendantPid, 20)).toBe(true);
    expect(recordedCommands().at(-1)?.label).toBe('observed process group probe');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('times out an observed command whose observer never settles', async () => {
  await expect(
    runObservedCommand({
      argv: ['/bin/sleep', '10'],
      cwd: process.cwd(),
      environment: {},
      label: 'observed timeout probe',
      observe: () => Promise.withResolvers<never>().promise,
      shutdownGraceMs: 50,
      timeoutMs: 100,
    }),
  ).rejects.toThrow('observed timeout probe exceeded its 100ms timeout');
});

it('bounds output draining when a descendant escapes the process group', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spike-command-escaped-timeout-'));
  const pidFile = path.join(root, 'escaped-descendant.pid');
  const escapedScript = `
    const child = Bun.spawn(['/bin/sleep', '10'], {
      detached: true,
      stderr: 'inherit',
      stdout: 'inherit',
    });
    await Bun.write(${JSON.stringify(pidFile)}, String(child.pid) + "\\n");
    child.unref();
  `;
  const startedAt = performance.now();
  let descendantPid: number | undefined;
  const command = runCommand({
    argv: [process.execPath, '-e', escapedScript],
    cwd: root,
    environment: {},
    label: 'escaped process group timeout probe',
    timeoutMs: ESCAPED_COMMAND_TIMEOUT_MS,
  });
  try {
    descendantPid = await waitForFixturePid(pidFile);
    expect(processExists(descendantPid)).toBe(true);
    await expect(command).rejects.toThrow(
      `escaped process group timeout probe exceeded its ${String(ESCAPED_COMMAND_TIMEOUT_MS)}ms timeout`,
    );
    expect(performance.now() - startedAt).toBeLessThan(
      ESCAPED_COMMAND_TIMEOUT_MS + MAX_TIMEOUT_OVERHEAD_MS,
    );
    expect(processExists(descendantPid)).toBe(true);
  } finally {
    await Promise.allSettled([command]);
    descendantPid ??= await readFixturePid(pidFile);
    if (descendantPid !== undefined && processExists(descendantPid)) {
      process.kill(descendantPid, 'SIGKILL');
      await waitForProcessExit(descendantPid, 20);
    }
    await rm(root, { force: true, recursive: true });
  }
});

it('uses an exact child environment when one is supplied', async () => {
  const key = 'SPIKE_VALIDATION_PARENT_SENTINEL';
  const previous = process.env[key];
  process.env[key] = 'must-not-leak';
  try {
    const result = await runCommand({
      argv: ['/usr/bin/env'],
      cwd: process.cwd(),
      environment: { SPIKE_VALIDATION_EXACT_SENTINEL: 'present' },
      label: 'exact environment probe',
      timeoutMs: 1000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('SPIKE_VALIDATION_EXACT_SENTINEL=present');
    expect(result.stdout).not.toContain(key);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = previous;
    }
  }
});
