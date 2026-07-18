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
import { afterEach, expect, vi } from 'vitest';

import { ensureRuntimeLayout } from '../src/config-files';
import { requestControl, startControlSocket } from '../src/control-socket';
import { serveDaemon } from '../src/daemon';
import { openJournal } from '../src/database';
import { SpikeRuntimeError } from '../src/errors';
import { spikePaths } from '../src/paths';
import { isDoctorReport } from '../src/status/doctor';
import {
  replaceMessagesDatabase,
  type MessagesFixture,
  withMessagesFixture,
} from './messages-fixture';

const roots: string[] = [];
const FAKE_CODEX_EXECUTABLE = fileURLToPath(
  new URL('fixtures/fake-codex-app-server.ts', import.meta.url),
);
const fixtureError = (message: string): SpikeRuntimeError =>
  new SpikeRuntimeError({ cause: null, message, operation: 'test/daemon' });

const prepareCodexDaemon = (
  paths: ReturnType<typeof spikePaths>,
  messagesDatabase: string,
  exitMarker: '.exit-after-initialize' | '.exit-during-turn' | '.exit-during-unavailable-turn',
): void => {
  writeFileSync(
    paths.config,
    `chat_guid = "any;-;+15555550199"
handle = "+15555550199"
working_directory = "/tmp"
like_acknowledgements = false
codex_executable = ${JSON.stringify(FAKE_CODEX_EXECUTABLE)}
messages_database = ${JSON.stringify(messagesDatabase)}
`,
  );
  writeFileSync(paths.codexConfig, 'model_provider = "fake"\n', 'utf8');
  writeFileSync(paths.prompt, 'You are a bounded daemon fixture.\n', 'utf8');
  writeFileSync(path.join(paths.codexHome, exitMarker), '', 'utf8');
};

const boundedDaemonJoin = (fiber: Fiber.Fiber<void, unknown>): Effect.Effect<void, unknown> =>
  Effect.race(
    Fiber.join(fiber),
    Effect.sleep(2000).pipe(
      Effect.flatMap(() => Effect.fail(fixtureError('daemon did not stop after Codex child exit'))),
    ),
  );

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

const attemptState = (databasePath: string): string | null => {
  if (!existsSync(databasePath)) {
    return null;
  }
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return (
      database
        .query<{ state: string }, []>(
          'SELECT state FROM codex_attempts ORDER BY rowid DESC LIMIT 1',
        )
        .get()?.state ?? null
    );
  } catch {
    return null;
  } finally {
    database.close();
  }
};

const conversationUnavailable = (databasePath: string): boolean => {
  if (!existsSync(databasePath)) {
    return false;
  }
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return (
      database
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM outage_episodes
           WHERE kind = 'MessagesConversationBoundaryInvalid' AND state = 'Open'`,
        )
        .get()?.count === 1
    );
  } catch {
    return false;
  } finally {
    database.close();
  }
};

const mirrorPreparedOutbound = (
  paths: ReturnType<typeof spikePaths>,
  messages: MessagesFixture,
): Effect.Effect<void, SpikeRuntimeError> =>
  Effect.gen(function* mirrorOutbound() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const text = preparedOutboundText(paths.database);
      if (text !== null) {
        messages.insertMessage({ guid: 'mirrored-outbound', isFromMe: true, rowId: 2, text });
        return yield* Effect.void;
      }
      yield* Effect.promise(() => Bun.sleep(10));
    }
    return yield* fixtureError('daemon did not prepare an outbound failure message');
  });

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
    yield* ensureRuntimeLayout(paths);
    writeFileSync(
      paths.config,
      `chat_guid = "any;-;+15555550199"
handle = "+15555550199"
working_directory = "/tmp"
like_acknowledgements = false
`,
    );
    writeFileSync(paths.codexConfig, 'approval_policy = "never"\n', 'utf8');
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

it.effect('stops cleanly when the Codex child exits so launchd can restart it', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* codexExitFixture() {
      const root = mkdtempSync(path.join(tmpdir(), 'spike-daemon-codex-exit-'));
      roots.push(root);
      const paths = spikePaths(root);
      yield* ensureRuntimeLayout(paths);
      prepareCodexDaemon(paths, messages.databasePath, '.exit-after-initialize');

      yield* Effect.race(
        serveDaemon(paths),
        Effect.sleep(2000).pipe(
          Effect.flatMap(() =>
            Effect.fail(fixtureError('daemon did not stop after Codex child exit')),
          ),
        ),
      );

      expect(existsSync(paths.socket)).toBe(false);
      const journal = yield* openJournal(paths.database);
      journal.close();
      const log = readFileSync(paths.daemonLog, 'utf8');
      expect(log).toContain('codex app-server connection closed; stopping daemon');
      expect(log).toContain('stopped');
    }),
  ),
);

it.effect('quiesces polling and fails an active turn before child-exit shutdown completes', () =>
  withMessagesFixture((messages) =>
    Effect.gen(function* activeTurnExitFixture() {
      const root = mkdtempSync(path.join(tmpdir(), 'spike-daemon-active-exit-'));
      roots.push(root);
      const paths = spikePaths(root);
      yield* ensureRuntimeLayout(paths);
      prepareCodexDaemon(paths, messages.databasePath, '.exit-during-turn');
      const fakeBin = path.join(root, 'fake-bin');
      mkdirSync(fakeBin);
      symlinkSync('/usr/bin/true', path.join(fakeBin, 'osascript'));
      const originalPath = process.env['PATH'];
      process.env['PATH'] = `${fakeBin}:${originalPath ?? ''}`;
      try {
        const fiber = yield* Effect.forkChild(serveDaemon(paths));
        for (let attempt = 0; attempt < 50 && !existsSync(paths.socket); attempt += 1) {
          yield* Effect.promise(() => Bun.sleep(10));
        }
        expect(existsSync(paths.socket)).toBe(true);

        const mirror = yield* Effect.forkChild(mirrorPreparedOutbound(paths, messages));
        messages.insertMessage({ guid: 'active-turn-input', rowId: 1, text: 'start then crash' });
        yield* boundedDaemonJoin(fiber);
        yield* Fiber.join(mirror);

        expect(existsSync(paths.socket)).toBe(false);
        const journal = yield* openJournal(paths.database);
        expect(
          journal.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()
            ?.state,
        ).toBe('Failed');
        expect(
          journal.database.query<{ state: string }, []>('SELECT state FROM codex_attempts').get()
            ?.state,
        ).toBe('Failed');
        journal.close();
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

it.effect(
  'releases unavailable conversation waiters while failing an active turn after child exit',
  () =>
    withMessagesFixture((messages) =>
      Effect.gen(function* unavailableActiveTurnExitFixture() {
        const root = mkdtempSync(path.join(tmpdir(), 'spike-daemon-unavailable-exit-'));
        roots.push(root);
        const paths = spikePaths(root);
        yield* ensureRuntimeLayout(paths);
        prepareCodexDaemon(paths, messages.databasePath, '.exit-during-unavailable-turn');
        const fakeBin = path.join(root, 'fake-bin');
        mkdirSync(fakeBin);
        symlinkSync('/usr/bin/true', path.join(fakeBin, 'osascript'));
        const originalPath = process.env['PATH'];
        process.env['PATH'] = `${fakeBin}:${originalPath ?? ''}`;
        try {
          const fiber = yield* Effect.forkChild(
            serveDaemon(paths, { conversationValidationIntervalMs: 1 }),
          );
          for (let attempt = 0; attempt < 50 && !existsSync(paths.socket); attempt += 1) {
            yield* Effect.promise(() => Bun.sleep(10));
          }
          expect(existsSync(paths.socket)).toBe(true);

          messages.insertMessage({
            guid: 'unavailable-active-turn-input',
            rowId: 1,
            text: 'start, invalidate Messages, then crash',
          });
          for (
            let attempt = 0;
            attempt < 100 && attemptState(paths.database) !== 'Accepted';
            attempt += 1
          ) {
            yield* Effect.promise(() => Bun.sleep(5));
          }
          expect(attemptState(paths.database)).toBe('Accepted');

          replaceMessagesDatabase(messages, (database) => {
            database.run("UPDATE chat SET chat_identifier = '+15555550000' WHERE ROWID = 1");
          });
          for (
            let attempt = 0;
            attempt < 200 && !conversationUnavailable(paths.database);
            attempt += 1
          ) {
            yield* Effect.promise(() => Bun.sleep(5));
          }
          expect(conversationUnavailable(paths.database)).toBe(true);
          writeFileSync(path.join(paths.codexHome, '.allow-unavailable-turn-exit'), '', 'utf8');

          yield* boundedDaemonJoin(fiber);
          expect(existsSync(paths.socket)).toBe(false);
          const journal = yield* openJournal(paths.database);
          expect(
            journal.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()
              ?.state,
          ).toBe('Failed');
          expect(
            journal.database.query<{ state: string }, []>('SELECT state FROM codex_attempts').get()
              ?.state,
          ).toBe('Failed');
          expect(
            journal.database
              .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM delivery_attempts')
              .get()?.count,
          ).toBe(0);
          journal.close();

          const currentMessages = new Database(messages.databasePath, {
            readonly: true,
            strict: true,
          });
          expect(
            currentMessages
              .query<{ count: number }, []>(
                'SELECT COUNT(*) AS count FROM message WHERE is_from_me = 1',
              )
              .get()?.count,
          ).toBe(0);
          currentMessages.close();
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
