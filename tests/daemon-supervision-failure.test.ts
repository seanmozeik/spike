import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber } from 'effect';
import { afterEach, expect } from 'vitest';

import { addStoredAccount } from '../src/codex/account-store';
import { ensureRuntimeLayout } from '../src/config-files';
import { serveDaemon } from '../src/daemon';
import { SpikeRuntimeError } from '../src/errors';
import { spikePaths, type SpikePaths } from '../src/paths';
import { withMessagesFixture } from './messages-fixture';

const roots: string[] = [];
const FAKE_CODEX_EXECUTABLE = fileURLToPath(
  new URL('fixtures/fake-codex-app-server.ts', import.meta.url),
);

const fixtureError = (message: string): SpikeRuntimeError =>
  new SpikeRuntimeError({ cause: null, message, operation: 'test/daemon-supervision' });

const prepareDaemon = (
  paths: SpikePaths,
  messagesDatabase: string,
  codexExecutable: string,
): void => {
  writeFileSync(
    paths.config,
    `chat_guid = "any;-;+15555550199"
handle = "+15555550199"
working_directory = "/tmp"
like_acknowledgements = false
codex_executable = ${JSON.stringify(codexExecutable)}
messages_database = ${JSON.stringify(messagesDatabase)}
`,
  );
  writeFileSync(paths.codexConfig, 'approval_policy = "never"\n', 'utf8');
  writeFileSync(paths.prompt, 'You are a daemon supervision fixture.\n', 'utf8');
};

const addAccount = (
  paths: SpikePaths,
  root: string,
  accountId: string,
): Effect.Effect<void, unknown> => {
  const source = path.join(root, `${accountId}.json`);
  writeFileSync(source, JSON.stringify({ account: accountId }), 'utf8');
  return addStoredAccount({ accountsDirectory: paths.accounts }, accountId, source).pipe(
    Effect.asVoid,
  );
};

const executable = (root: string, name: string, script: string): string => {
  const target = path.join(root, name);
  writeFileSync(target, script, 'utf8');
  chmodSync(target, 0o700);
  return target;
};

const waitForSocket = (paths: SpikePaths): Effect.Effect<void, SpikeRuntimeError> =>
  Effect.gen(function* awaitControlSocket() {
    for (let attempt = 0; attempt < 100 && !existsSync(paths.socket); attempt += 1) {
      yield* Effect.promise(() => Bun.sleep(10));
    }
    if (!existsSync(paths.socket)) {
      return yield* fixtureError('daemon control socket did not start');
    }
    return yield* Effect.void;
  });

const boundedDaemonExit = (
  daemon: Fiber.Fiber<void, unknown>,
): Effect.Effect<Exit.Exit<void, unknown>, unknown> =>
  Effect.raceFirst(
    Fiber.await(daemon),
    Effect.sleep(2000).pipe(
      Effect.flatMap(() => Effect.fail(fixtureError('daemon ignored account supervisor failure'))),
    ),
  );

const failureMessage = (exit: Exit.Exit<void, unknown>): string => {
  if (Exit.isSuccess(exit)) {
    throw new Error('daemon unexpectedly succeeded');
  }
  return Cause.pretty(exit.cause);
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('fails fast and removes the socket when initial app-server initialization fails', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* initialFailureFixture() {
      const root = mkdtempSync(path.join(tmpdir(), 'spike-daemon-initial-open-failure-'));
      roots.push(root);
      const paths = spikePaths(root);
      yield* ensureRuntimeLayout(paths);
      const failing = executable(root, 'fail-codex', '#!/bin/sh\n/bin/sleep 0.05\nexit 17\n');
      prepareDaemon(paths, messages.databasePath, failing);
      yield* addAccount(paths, root, 'primary');

      const daemon = yield* Effect.forkChild(serveDaemon(paths));
      yield* waitForSocket(paths);
      const exit = yield* boundedDaemonExit(daemon);

      expect(failureMessage(exit)).toContain('failed to open Codex account primary');
      expect(existsSync(paths.socket)).toBe(false);
      expect(readFileSync(paths.daemonLog, 'utf8')).toContain('stopped');
    }),
  ),
);

it.effect('fails fast and removes the socket when replacement initialization fails', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* replacementFailureFixture() {
      const root = mkdtempSync(path.join(tmpdir(), 'spike-daemon-replacement-open-failure-'));
      roots.push(root);
      const paths = spikePaths(root);
      yield* ensureRuntimeLayout(paths);
      const wrapper = executable(
        root,
        'account-aware-codex',
        `#!/bin/sh
if /usr/bin/grep -q '"account":"secondary"' "$CODEX_HOME/auth.json"; then
  exit 17
fi
exec ${JSON.stringify(FAKE_CODEX_EXECUTABLE)} "$@"
`,
      );
      prepareDaemon(paths, messages.databasePath, wrapper);
      writeFileSync(path.join(paths.codexHome, '.fail-primary-capacity'), '', 'utf8');
      yield* addAccount(paths, root, 'primary');
      yield* addAccount(paths, root, 'secondary');

      const daemon = yield* Effect.forkChild(serveDaemon(paths));
      yield* waitForSocket(paths);
      messages.insertMessage({ guid: 'replacement-open-failure', rowId: 1, text: 'rotate now' });
      const exit = yield* boundedDaemonExit(daemon);

      expect(failureMessage(exit)).toContain('failed to open Codex account secondary');
      expect(existsSync(paths.socket)).toBe(false);
      expect(readFileSync(paths.daemonLog, 'utf8')).toContain('stopped');
    }),
  ),
);
