import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { afterEach, expect } from 'vitest';

import { addStoredAccount } from '../src/codex/account-store';
import { ensureRuntimeLayout } from '../src/config-files';
import { requestControl } from '../src/control-socket';
import { serveDaemon } from '../src/daemon';
import { openJournal } from '../src/database';
import { AccountId } from '../src/domain/ids';
import { makeCodexJournal } from '../src/journal/codex-journal';
import { spikePaths } from '../src/paths';
import { withMessagesFixture } from './messages-fixture';
import { makeDeliveredOutageFixture, outageDeliveryFixture } from './outage-fixture';

const roots: string[] = [];
const FAKE_CODEX_EXECUTABLE = fileURLToPath(
  new URL('fixtures/fake-codex-app-server.ts', import.meta.url),
);

const activeAccount = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || !('active' in value)) {
    return null;
  }
  return typeof value.active === 'string' ? value.active : null;
};

const accountState = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || !('state' in value)) {
    return null;
  }
  const { state } = value;
  return typeof state === 'object' && state !== null && 'kind' in state ? String(state.kind) : null;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('rotates a Prepared turn without treating the planned child close as daemon death', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* plannedRotationFixture() {
      const root = mkdtempSync(path.join(tmpdir(), 'spike-daemon-account-rotation-'));
      roots.push(root);
      const paths = spikePaths(root);
      yield* ensureRuntimeLayout(paths);
      writeFileSync(
        paths.config,
        `chat_guid = "any;-;+15555550199"
handle = "+15555550199"
working_directory = "/tmp"
like_acknowledgements = false
codex_executable = ${JSON.stringify(FAKE_CODEX_EXECUTABLE)}
messages_database = ${JSON.stringify(messages.databasePath)}
`,
      );
      writeFileSync(paths.codexConfig, 'approval_policy = "never"\n', 'utf8');
      writeFileSync(paths.prompt, 'You are a failover fixture.\n', 'utf8');
      writeFileSync(path.join(paths.codexHome, '.fail-primary-capacity'), '', 'utf8');
      const primary = path.join(root, 'primary.json');
      const secondary = path.join(root, 'secondary.json');
      writeFileSync(primary, '{"account":"primary","token":"secret-primary"}', 'utf8');
      writeFileSync(secondary, '{"account":"secondary","token":"secret-secondary"}', 'utf8');
      yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'primary', primary);
      yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'secondary', secondary);

      const fakeBin = path.join(root, 'fake-bin');
      mkdirSync(fakeBin);
      symlinkSync('/usr/bin/true', path.join(fakeBin, 'osascript'));
      const originalPath = process.env['PATH'];
      process.env['PATH'] = `${fakeBin}:${originalPath ?? ''}`;
      try {
        const daemon = yield* Effect.forkChild(
          serveDaemon(paths, { outageDelivery: outageDeliveryFixture }),
        );
        for (let index = 0; index < 100 && !existsSync(paths.socket); index += 1) {
          yield* Effect.promise(() => Bun.sleep(10));
        }
        expect(existsSync(paths.socket)).toBe(true);
        messages.insertMessage({ guid: 'rotation-input', rowId: 1, text: 'survive rotation' });

        let account: string | null = null;
        for (let index = 0; index < 300 && account !== 'secondary'; index += 1) {
          const listed = yield* Effect.promise(() =>
            requestControl(paths.socket, { kind: 'accounts-list' }),
          );
          account = activeAccount(listed);
          if (account !== 'secondary') {
            yield* Effect.promise(() => Bun.sleep(10));
          }
        }
        expect(account).toBe('secondary');
        expect(existsSync(paths.socket)).toBe(true);

        for (let index = 0; index < 100; index += 1) {
          const pending = new Database(paths.database, { readonly: true, strict: true });
          const recovered = pending
            .query<{ account_id: string; state: string }, []>(
              'SELECT account_id, state FROM codex_attempts ORDER BY rowid DESC LIMIT 1',
            )
            .get();
          pending.close();
          if (recovered?.account_id === 'secondary' && recovered.state === 'Accepted') {
            break;
          }
          yield* Effect.promise(() => Bun.sleep(10));
        }

        const database = new Database(paths.database, { readonly: true, strict: true });
        expect(
          database
            .query<{ account_id: string; state: string }, []>(
              'SELECT account_id, state FROM codex_attempts ORDER BY rowid DESC LIMIT 1',
            )
            .get(),
        ).toEqual({ account_id: 'secondary', state: 'Accepted' });
        expect(
          database
            .query<{ mode: string }, []>(
              `SELECT mode FROM account_observations
               WHERE account_id = 'primary' ORDER BY id DESC LIMIT 1`,
            )
            .get()?.mode,
        ).toBe('Capacity');
        database.close();

        yield* Effect.promise(() => requestControl(paths.socket, { kind: 'shutdown' }));
        yield* Fiber.join(daemon);
        expect(readFileSync(paths.daemonLog, 'utf8')).not.toContain(
          'codex app-server connection closed; stopping daemon',
        );
      } finally {
        if (originalPath === undefined) {
          delete process.env['PATH'];
        } else {
          process.env['PATH'] = originalPath;
        }
      }
    }),
  ),
);

it.effect('keeps control live across restart-style capacity waiting and wakes on account add', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* durableWaitingFixture() {
      const root = mkdtempSync(path.join(tmpdir(), 'spike-daemon-account-wait-'));
      roots.push(root);
      const paths = spikePaths(root);
      yield* ensureRuntimeLayout(paths);
      writeFileSync(
        paths.config,
        `chat_guid = "any;-;+15555550199"
handle = "+15555550199"
working_directory = "/tmp"
like_acknowledgements = false
codex_executable = ${JSON.stringify(FAKE_CODEX_EXECUTABLE)}
messages_database = ${JSON.stringify(messages.databasePath)}
`,
      );
      writeFileSync(paths.codexConfig, 'approval_policy = "never"\n', 'utf8');
      writeFileSync(paths.prompt, 'You are a waiting fixture.\n', 'utf8');
      const primary = path.join(root, 'primary.json');
      const secondary = path.join(root, 'secondary.json');
      writeFileSync(primary, '{"account":"primary"}', 'utf8');
      writeFileSync(secondary, '{"account":"secondary","token":"never-return-me"}', 'utf8');
      yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'primary', primary);
      const handle = yield* openJournal(paths.database);
      yield* makeCodexJournal(handle.database).recordAccountObservation(
        AccountId.make('primary'),
        'Capacity',
        null,
        new Date('2099-01-01T00:00:00.000Z'),
        new Date(),
      );
      handle.close();

      const daemon = yield* Effect.forkChild(
        serveDaemon(paths, { outageDelivery: makeDeliveredOutageFixture(paths.database) }),
      );
      for (let index = 0; index < 100 && !existsSync(paths.socket); index += 1) {
        yield* Effect.promise(() => Bun.sleep(10));
      }
      expect(existsSync(paths.socket)).toBe(true);
      let listed: unknown = null;
      for (
        let index = 0;
        index < 100 && accountState(listed) !== 'WaitingForCapacity';
        index += 1
      ) {
        listed = yield* Effect.promise(() =>
          requestControl(paths.socket, { kind: 'accounts-list' }),
        );
        if (accountState(listed) !== 'WaitingForCapacity') {
          yield* Effect.promise(() => Bun.sleep(10));
        }
      }
      expect(accountState(listed)).toBe('WaitingForCapacity');

      const added = yield* Effect.promise(() =>
        requestControl(paths.socket, {
          accountId: 'secondary',
          kind: 'accounts-add',
          sourcePath: secondary,
        }),
      );
      expect(JSON.stringify(added)).not.toContain('never-return-me');
      for (let index = 0; index < 100 && activeAccount(listed) !== 'secondary'; index += 1) {
        yield* Effect.promise(() => Bun.sleep(10));
        listed = yield* Effect.promise(() =>
          requestControl(paths.socket, { kind: 'accounts-list' }),
        );
      }
      expect(activeAccount(listed)).toBe('secondary');

      yield* Effect.promise(() => requestControl(paths.socket, { kind: 'shutdown' }));
      yield* Fiber.join(daemon);
    }),
  ),
);
