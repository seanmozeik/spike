import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
  recordedCommands,
  runCommand,
  runObservedCommand,
} from '../scripts/package-validation-command';

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
    await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
    child.unref();
  `;
  const startedAt = performance.now();
  let descendantPid: number | undefined;
  try {
    await expect(
      runCommand({
        argv: [process.execPath, '-e', escapedScript],
        cwd: root,
        environment: {},
        label: 'escaped process group timeout probe',
        timeoutMs: 100,
      }),
    ).rejects.toThrow('escaped process group timeout probe exceeded its 100ms timeout');
    expect(performance.now() - startedAt).toBeLessThan(1000);

    descendantPid = Number(await readFile(pidFile, 'utf8'));
    expect(processExists(descendantPid)).toBe(true);
  } finally {
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
