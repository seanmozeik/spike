import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import type { AccountAddResult } from '../src/codex/account-control';
import { addStoredAccount } from '../src/codex/account-store';
import { ensureRuntimeLayout } from '../src/config-files';
import { requestControl, startControlSocket } from '../src/control-socket';
import { spikePaths } from '../src/paths';
import { ControlRequestError } from '../src/protocol';

interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const unexpectedShutdown = (): never => {
  throw new Error('control server received an unexpected shutdown request');
};

const closeServer = (server: Server): Effect.Effect<void> =>
  Effect.promise(async () => {
    const closed = once(server, 'close');
    server.close();
    await closed;
  });

const runCli = async (root: string, arguments_: readonly string[]): Promise<CliResult> => {
  const child = Bun.spawn([process.execPath, 'run', CLI_PATH, ...arguments_], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, SPIKE_HOME: root },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
};

const failurePayload = (result: CliResult): Record<string, unknown> => {
  expect(result.stderr).toBe('');
  const payload: unknown = JSON.parse(result.stdout);
  if (!isRecord(payload)) {
    throw new Error('CLI failure payload must be an object');
  }
  return payload;
};

const addAccount = (
  accountsDirectory: string,
  accountId: string,
  sourcePath: string,
): Promise<AccountAddResult> =>
  Effect.runPromise(
    addStoredAccount({ accountsDirectory }, accountId, sourcePath).pipe(
      Effect.map((account) => ({ account: { id: account.id }, ok: true as const })),
    ),
  );

it.effect('fails typed control requests and real account-add CLI invocations', () =>
  Effect.gen(function* accountAddFailureFixture() {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'spike-control-'))),
      (directory) =>
        Effect.sync(() => {
          rmSync(directory, { force: true, recursive: true });
        }),
    );
    const paths = spikePaths(root);
    yield* ensureRuntimeLayout(paths);
    const source = path.join(root, 'auth.json');
    writeFileSync(source, '{"token":"secret"}', 'utf8');
    yield* Effect.acquireRelease(
      Effect.promise(() =>
        startControlSocket(
          paths,
          new Date().toISOString(),
          unexpectedShutdown,
          undefined,
          undefined,
          undefined,
          {
            add: (accountId, sourcePath) => addAccount(paths.accounts, accountId, sourcePath),
            list: () =>
              Promise.resolve({
                accounts: [],
                active: null,
                observations: [],
                ok: true,
                state: null,
              }),
          },
        ),
      ),
      closeServer,
    );

    yield* Effect.promise(async () => {
      await expect(
        requestControl(paths.socket, {
          accountId: '../escape',
          kind: 'accounts-add',
          sourcePath: source,
        }),
      ).rejects.toBeInstanceOf(ControlRequestError);
    });

    const invalidId = yield* Effect.promise(() =>
      runCli(root, ['accounts', 'add', '--agent', '../escape', source]),
    );
    expect(invalidId.exitCode).toBe(1);
    expect(failurePayload(invalidId)).toMatchObject({ code: 'error', ok: false });

    const missingSource = yield* Effect.promise(() =>
      runCli(root, [
        'accounts',
        'add',
        '--agent',
        'missing-source',
        path.join(root, 'missing.json'),
      ]),
    );
    expect(missingSource.exitCode).toBe(1);
    expect(failurePayload(missingSource)).toMatchObject({ code: 'error', ok: false });
  }).pipe(Effect.scoped),
);
