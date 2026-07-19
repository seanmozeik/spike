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
import { serveDaemon } from '../src/daemon';
import { SpikeRuntimeError } from '../src/errors';
import { spikePaths } from '../src/paths';
import { type MessagesFixture, withMessagesFixture } from './messages-fixture';

const roots: string[] = [];
const FAKE_CODEX_EXECUTABLE = fileURLToPath(
  new URL('fixtures/fake-codex-app-server.ts', import.meta.url),
);

const fixtureError = (message: string): SpikeRuntimeError =>
  new SpikeRuntimeError({ cause: null, message, operation: 'test/account-failover-child-death' });

const preparedOutboundText = (databasePath: string): string | null => {
  if (!existsSync(databasePath)) {
    return null;
  }
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return (
      database
        .query<{ text: string }, []>(
          "SELECT text FROM outbound_chunks WHERE state = 'Prepared' ORDER BY rowid DESC LIMIT 1",
        )
        .get()?.text ?? null
    );
  } catch {
    return null;
  } finally {
    database.close();
  }
};

const mirrorPreparedOutbound = (
  databasePath: string,
  messages: MessagesFixture,
): Effect.Effect<void, SpikeRuntimeError> =>
  Effect.gen(function* mirrorOutbound() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const text = preparedOutboundText(databasePath);
      if (text !== null) {
        messages.insertMessage({
          guid: 'mirrored-failover-output',
          isFromMe: true,
          rowId: 2,
          text,
        });
        return yield* Effect.void;
      }
      yield* Effect.promise(() => Bun.sleep(10));
    }
    return yield* fixtureError('daemon did not prepare an outbound failure message');
  });

const boundedDaemonJoin = (fiber: Fiber.Fiber<void, unknown>): Effect.Effect<void, unknown> =>
  Effect.raceFirst(
    Fiber.join(fiber),
    Effect.sleep(2000).pipe(
      Effect.flatMap(() => Effect.fail(fixtureError('daemon did not stop after replacement died'))),
    ),
  );

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('stops the daemon when the replacement app-server dies during account rotation', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* replacementDeathFixture() {
      const root = mkdtempSync(path.join(tmpdir(), 'spike-daemon-failover-child-death-'));
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
      writeFileSync(paths.prompt, 'You are a failover child-death fixture.\n', 'utf8');
      writeFileSync(path.join(paths.codexHome, '.fail-primary-capacity'), '', 'utf8');
      writeFileSync(path.join(paths.codexHome, '.exit-during-turn'), '', 'utf8');
      const primary = path.join(root, 'primary.json');
      const secondary = path.join(root, 'secondary.json');
      writeFileSync(primary, '{"account":"primary"}', 'utf8');
      writeFileSync(secondary, '{"account":"secondary"}', 'utf8');
      yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'primary', primary);
      yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'secondary', secondary);

      const fakeBin = path.join(root, 'fake-bin');
      mkdirSync(fakeBin);
      symlinkSync('/usr/bin/true', path.join(fakeBin, 'osascript'));
      const originalPath = process.env['PATH'];
      process.env['PATH'] = `${fakeBin}:${originalPath ?? ''}`;
      try {
        const daemon = yield* Effect.forkChild(serveDaemon(paths));
        for (let attempt = 0; attempt < 100 && !existsSync(paths.socket); attempt += 1) {
          yield* Effect.promise(() => Bun.sleep(10));
        }
        expect(existsSync(paths.socket)).toBe(true);

        const mirror = yield* Effect.forkChild(mirrorPreparedOutbound(paths.database, messages));
        messages.insertMessage({ guid: 'failover-child-death', rowId: 1, text: 'rotate then die' });
        yield* boundedDaemonJoin(daemon);
        yield* Fiber.join(mirror);

        expect(existsSync(paths.socket)).toBe(false);
        const database = new Database(paths.database, { readonly: true, strict: true });
        expect(
          database
            .query<{ account_id: string; state: string }, []>(
              'SELECT account_id, state FROM codex_attempts ORDER BY rowid DESC LIMIT 1',
            )
            .get(),
        ).toEqual({ account_id: 'secondary', state: 'Failed' });
        expect(
          database
            .query<{ mode: string }, []>(
              `SELECT mode FROM account_observations
               WHERE account_id = 'primary' ORDER BY id DESC LIMIT 1`,
            )
            .get()?.mode,
        ).toBe('Capacity');
        database.close();
        expect(readFileSync(paths.daemonLog, 'utf8')).toContain(
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
