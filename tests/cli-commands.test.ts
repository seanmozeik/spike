import { BunServices } from '@effect/platform-bun';
import { Effect, Result } from 'effect';
import { Command } from 'effect/unstable/cli';
import { afterEach, expect, it, vi } from 'vitest';

import { formatApprovals, makeCliApp, type OperationHandlers } from '../src/cli-commands';
import { SpikeRuntimeError } from '../src/errors';

const outputs = {
  accounts: { accounts: [], active: null, observations: [], ok: true, state: null },
  approvals: {
    approvals: [
      {
        deliveredAt: '2026-07-19T10:00:01.000Z',
        expiresAt: '2026-07-19T10:10:00.000Z',
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        operation: 'Command',
        requestedAt: '2026-07-19T10:00:00.000Z',
        resolvedAt: null,
        state: 'Pending',
      },
    ],
    ok: true,
  },
  doctor: {
    checks: [{ detail: 'configured hook file available', name: 'hooks', state: 'pass' }],
    healthy: true,
    ok: true,
  },
  logs: { ok: true, path: '/tmp/daemon.log', text: 'ready' },
  restart: { label: 'com.mozeik.spike', ok: true, status: 'started' },
  start: { label: 'com.mozeik.spike', ok: true, status: 'started' },
  status: { loaded: true, ok: true, running: false, service: 'spike', socket: '/tmp/spike.sock' },
  stop: { label: 'com.mozeik.spike', ok: true, status: 'stopped' },
} as const;

const suppressConsoleLog = (..._values: readonly unknown[]): void => {
  // Silence output while retaining Vitest's mock call history.
};

const handlersWith = (calls: string[]): OperationHandlers => {
  const handler =
    <Name extends keyof typeof outputs>(name: Name): (() => Promise<(typeof outputs)[Name]>) =>
    () => {
      calls.push(name);
      return Promise.resolve(outputs[name]);
    };
  return {
    accounts: handler('accounts'),
    addAccount: (accountId, sourcePath) => {
      calls.push(`addAccount:${accountId}:${sourcePath}`);
      return Promise.resolve({ account: { id: accountId }, ok: true });
    },
    approvals: handler('approvals'),
    doctor: handler('doctor'),
    logs: handler('logs'),
    restart: handler('restart'),
    start: handler('start'),
    status: handler('status'),
    stop: handler('stop'),
  };
};

const commandRunner = (calls: string[]): ((args: readonly string[]) => Promise<void>) => {
  const handlers = handlersWith(calls);
  const run = Command.runWith(makeCliApp(handlers), { version: 'test' });
  return (args: readonly string[]): Promise<void> =>
    Effect.runPromise(run(args).pipe(Effect.provide(BunServices.layer)));
};

afterEach(() => {
  vi.restoreAllMocks();
});

it('routes every operator subcommand through its injected handler', async () => {
  const calls: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(suppressConsoleLog);
  const run = commandRunner(calls);

  await run(['start']);
  await run(['stop']);
  await run(['restart']);
  await run(['status']);
  await run(['doctor']);
  await run(['logs']);
  await run(['approvals']);
  await run(['accounts', 'list']);
  await run(['accounts', 'add', 'secondary', '/tmp/auth.json']);

  expect(calls).toStrictEqual([
    'start',
    'stop',
    'restart',
    'status',
    'doctor',
    'logs',
    'approvals',
    'accounts',
    'addAccount:secondary:/tmp/auth.json',
  ]);
  expect(log).toHaveBeenCalledTimes(9);
});

it('renders hook diagnostics for humans and keeps the structured doctor object stable', async () => {
  const calls: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(suppressConsoleLog);
  const run = commandRunner(calls);

  await run(['doctor']);
  await run(['doctor', '--agent']);

  expect(log.mock.calls[0]?.[0]).toBe(
    'Spike doctor: healthy\n✓ hooks: configured hook file available',
  );
  expect(log.mock.calls[1]?.[0]).toBe(JSON.stringify(outputs.doctor));
  expect(calls).toStrictEqual(['doctor', 'doctor']);
});

it('renders approval status for humans and keeps the structured list stable', async () => {
  const calls: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(suppressConsoleLog);
  const run = commandRunner(calls);

  await run(['approvals']);
  await run(['approvals', '--agent']);

  expect(log.mock.calls[0]?.[0]).toBe(
    'Pending · Command · item/commandExecution/requestApproval · approval-1',
  );
  expect(log.mock.calls[1]?.[0]).toBe(JSON.stringify(outputs.approvals));
  expect(formatApprovals({ approvals: [], ok: true })).toBe('No approvals.');
  expect(calls).toStrictEqual(['approvals', 'approvals']);
});

it('preserves typed operator failures through the CLI boundary', async () => {
  const failure = new SpikeRuntimeError({
    cause: { argv: ['launchctl', 'bootstrap', 'gui/501', '/tmp/spike.plist'] },
    message: 'launchctl bootstrap failed: permission denied',
    operation: 'launchctl/bootstrap',
  });
  const handlers: OperationHandlers = { ...handlersWith([]), start: () => Promise.reject(failure) };
  const run = Command.runWith(makeCliApp(handlers), { version: 'test' });
  const provided = run(['start']).pipe(Effect.provide(BunServices.layer));
  const outcome = await Effect.runPromise(Effect.result(provided));

  expect(Result.isFailure(outcome)).toBe(true);
  if (Result.isFailure(outcome)) {
    expect(outcome.failure).toBe(failure);
  }
});
