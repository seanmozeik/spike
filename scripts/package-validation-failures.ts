import assert from 'node:assert/strict';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import { Schema } from 'effect';

import { requireFailureExactly, runObservedCommand } from './package-validation-command';
import { COMMAND_TIMEOUT_MS, isolatedEnvironment, runCli } from './package-validation-environment';
import { createMessagesFixture, writeSpikeFixture } from './package-validation-fixtures';

const WAIT_TIMEOUT_MS = 5000;
const AccountStateResponse = Schema.Struct({
  state: Schema.NullOr(Schema.Struct({ kind: Schema.String })),
});
const decodeAccountState = Schema.decodeUnknownSync(AccountStateResponse);

const pathExists = async (file: string): Promise<boolean> => {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
};

const waitForAuthenticationState = async (
  cli: string,
  work: string,
  environment: Readonly<Record<string, string>>,
  home: string,
): Promise<void> => {
  let observed = false;
  let lastObservation = 'control socket was not observed';
  const result = await runObservedCommand({
    argv: [cli, 'serve'],
    cwd: work,
    environment,
    label: 'serve while waiting for authentication',
    observe: async (command) => {
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      const socket = path.join(home, 'run', 'spike.sock');
      const observeAccountState = async (): Promise<void> => {
        if (Date.now() >= deadline || !command.isRunning()) {
          return;
        }
        if (await pathExists(socket)) {
          const accounts = await runCli(
            cli,
            ['accounts', 'list', '--json'],
            work,
            environment,
            'inspect waiting authentication state',
          );
          if (accounts.exitCode === 0) {
            const response = decodeAccountState(JSON.parse(accounts.stdout) as unknown);
            lastObservation = `account state ${response.state?.kind ?? 'null'}`;
            if (response.state?.kind === 'WaitingForAuthentication') {
              observed = true;
              return;
            }
          } else {
            lastObservation = `accounts command exited ${String(accounts.exitCode)}: ${accounts.stderr}`;
          }
        }
        await Bun.sleep(25);
        await observeAccountState();
      };
      await observeAccountState();
      if (!observed) {
        const runEntries = await readdir(path.join(home, 'run')).catch(() => []);
        const log = await Bun.file(path.join(home, 'logs', 'daemon.log'))
          .text()
          .catch(() => '');
        lastObservation = `${lastObservation}; run=${runEntries.join(',')}; log=${log}`;
      }
      assert.equal(
        observed,
        true,
        `missing authentication did not reach its bounded waiting state; running=${String(command.isRunning())}; ${lastObservation}`,
      );
      assert.equal(
        command.isRunning(),
        true,
        'missing authentication unexpectedly stopped the daemon',
      );
    },
    recordedArgv: ['<packaged spike>', 'serve'],
    recordedCwd: '<temporary work directory>',
    shutdownGraceMs: 1000,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  assert.equal(
    result.exitCode === 0 || result.exitCode === 137 || result.exitCode === 143,
    true,
    `waiting authentication probe exited unexpectedly: ${String(result.exitCode)}`,
  );
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
};

const validateWaitingAuthentication = async (
  validationRoot: string,
  cli: string,
  work: string,
  fakeBin: string,
  fakeCodex: string,
  messagesDatabase: string,
): Promise<void> => {
  const home = path.join(validationRoot, 'homes', 'authentication');
  const userHome = path.join(validationRoot, 'users', 'authentication');
  await mkdir(userHome, { recursive: true });
  await writeSpikeFixture(home, {
    codexExecutable: fakeCodex,
    customProvider: false,
    messagesDatabase,
    workingDirectory: work,
  });
  const environment = isolatedEnvironment(validationRoot, home, userHome, fakeBin);
  await waitForAuthenticationState(cli, work, environment, home);
};

const validateTerminalFailures = async (
  validationRoot: string,
  cli: string,
  work: string,
  fakeBin: string,
  fakeCodex: string,
  messagesDatabase: string,
): Promise<void> => {
  const userHome = path.join(validationRoot, 'users', 'failures');
  await mkdir(userHome, { recursive: true });
  const cases = [
    {
      environment: { SPIKE_VALIDATION_CODEX_MODE: 'provider-error' },
      expectedError:
        'failed to open the configured Codex provider: failed to initialize Codex app-server: fixture provider unavailable',
      home: 'provider',
      label: 'unavailable provider',
      messagesDatabase,
    },
    {
      environment: {},
      expectedError:
        'failed to open Messages inbox: Spike cannot open chat.db read-only. Grant Full Disk Access to the Bun executable that runs spike.: unable to open database file',
      home: 'messages',
      label: 'unavailable Messages database',
      messagesDatabase: path.join(validationRoot, 'messages-missing.db'),
    },
  ] as const;
  await Promise.all(
    cases.map(async (fixture) => {
      const home = path.join(validationRoot, 'homes', fixture.home);
      await writeSpikeFixture(home, {
        codexExecutable: fakeCodex,
        customProvider: true,
        messagesDatabase: fixture.messagesDatabase,
        workingDirectory: work,
      });
      const environment = {
        ...isolatedEnvironment(validationRoot, home, userHome, fakeBin),
        ...fixture.environment,
      };
      const result = await runCli(cli, ['serve'], work, environment, fixture.label);
      requireFailureExactly(result, fixture.expectedError, fixture.label);
    }),
  );
};

const validateActionableFailures = async (
  validationRoot: string,
  cli: string,
  work: string,
  fakeBin: string,
  fakeCodex: string,
): Promise<void> => {
  const messagesDatabase = path.join(validationRoot, 'messages-failures.db');
  createMessagesFixture(messagesDatabase);
  await validateWaitingAuthentication(
    validationRoot,
    cli,
    work,
    fakeBin,
    fakeCodex,
    messagesDatabase,
  );
  await validateTerminalFailures(validationRoot, cli, work, fakeBin, fakeCodex, messagesDatabase);
};

export { validateActionableFailures };
