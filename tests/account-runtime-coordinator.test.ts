import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { afterEach, expect, vi } from 'vitest';

import type { SpikeConfig } from '../src/app-config';
import { makeAccountRuntimeCoordinator } from '../src/codex/account-runtime-coordinator';
import { AccountRuntimeStateController } from '../src/codex/account-runtime-state';
import { addStoredAccount } from '../src/codex/account-store';
import type { CodexRuntime } from '../src/codex/runtime';
import { ensureRuntimeLayout } from '../src/config-files';
import { openJournal } from '../src/database';
import { AccountId, ChatGuid } from '../src/domain/ids';
import { CodexRuntimeError } from '../src/errors';
import { makeCodexJournal } from '../src/journal/codex-journal';
import { spikePaths, type SpikePaths } from '../src/paths';
import { makeRuntimeHarness } from './fake-codex-runtime';

const roots: string[] = [];

const fixture = (): { config: SpikeConfig; paths: SpikePaths; root: string } => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-account-coordinator-'));
  roots.push(root);
  const paths = spikePaths(root);
  const config: SpikeConfig = {
    casing: 'natural',
    chatGuid: ChatGuid.make('any;-;+15555550199'),
    codexExecutable: 'codex',
    codexHome: paths.codexHome,
    emoji: 'off',
    finalPunctuation: 'natural',
    handle: '+15555550199',
    likeAcknowledgements: false,
    messagesDatabase: path.join(root, 'chat.db'),
    promptPath: paths.prompt,
    swearing: 'off',
    wit: 'off',
    workingDirectory: root,
  };
  return { config, paths, root };
};

const fakeRuntime = (
  accountId: string,
  close: () => void = (): void => undefined,
): CodexRuntime => {
  const { runtime } = makeRuntimeHarness({}, { id: 'thread', turns: [] });
  return {
    ...runtime,
    accountId,
    close: (): Promise<void> => {
      close();
      return Promise.resolve();
    },
  };
};

const credential = (root: string, name: string): string => {
  const source = path.join(root, `${name}.json`);
  writeFileSync(source, JSON.stringify({ token: `secret-${name}` }), 'utf8');
  return source;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('does not lose an account-add wake before the wait effect starts', () =>
  Effect.gen(function* accountAddRaceFixture() {
    const state = yield* AccountRuntimeStateController.make;
    const waiting = state.wait(null, state.version, new Date());

    yield* state.notify();
    const outcome = yield* Effect.race(
      waiting.pipe(Effect.as('woke')),
      Effect.promise(() => Bun.sleep(100)).pipe(Effect.as('timed-out')),
    );
    expect(outcome).toBe('woke');
  }),
);

it.effect('serializes concurrent selection and records one durable LRU choice', () =>
  Effect.gen(function* concurrentSelectionFixture() {
    const { config, paths, root } = fixture();
    yield* ensureRuntimeLayout(paths);
    yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'alpha', credential(root, 'a'));
    const handle = yield* openJournal(paths.database);
    const journal = makeCodexJournal(handle.database);
    const opened = vi.fn(() => fakeRuntime('alpha'));
    const coordinator = yield* makeAccountRuntimeCoordinator(paths, config, journal, {
      openAccount: () => Effect.sync(opened),
      readProvider: Effect.succeed(null),
    });

    const [left, right] = yield* Effect.all([coordinator.acquire, coordinator.acquire], {
      concurrency: 'unbounded',
    });
    expect(left).toBe(right);
    expect(opened).toHaveBeenCalledTimes(1);
    expect((yield* journal.loadAccountObservations)[0]?.lastSelectedAt).not.toBeNull();

    yield* coordinator.release(left);
    yield* coordinator.close;
    handle.close();
  }),
);

it.effect('persists LRU selection so restart deterministically chooses the unused account', () =>
  Effect.gen(function* restartSelectionFixture() {
    const { config, paths, root } = fixture();
    yield* ensureRuntimeLayout(paths);
    yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'alpha', credential(root, 'a'));
    yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'beta', credential(root, 'b'));
    const handle = yield* openJournal(paths.database);
    const journal = makeCodexJournal(handle.database);
    const options = {
      openAccount: (account: { readonly id: string }): Effect.Effect<CodexRuntime> =>
        Effect.succeed(fakeRuntime(account.id)),
      readProvider: Effect.succeed(null),
    };
    const first = yield* makeAccountRuntimeCoordinator(paths, config, journal, options);
    const firstRuntime = yield* first.acquire;
    expect(firstRuntime.accountId).toBe('alpha');
    yield* first.release(firstRuntime);
    yield* first.close;

    const restarted = yield* makeAccountRuntimeCoordinator(paths, config, journal, options);
    const secondRuntime = yield* restarted.acquire;
    expect(secondRuntime.accountId).toBe('beta');
    yield* restarted.release(secondRuntime);
    yield* restarted.close;
    handle.close();
  }),
);

it.effect('waits durably when all accounts are exhausted and wakes when an account is added', () =>
  Effect.gen(function* capacityWaitFixture() {
    const { config, paths, root } = fixture();
    yield* ensureRuntimeLayout(paths);
    yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'alpha', credential(root, 'a'));
    const handle = yield* openJournal(paths.database);
    const journal = makeCodexJournal(handle.database);
    const now = new Date('2026-07-14T12:00:00Z');
    yield* journal.recordAccountObservation(
      AccountId.make('alpha'),
      'Capacity',
      null,
      new Date('2026-07-14T17:00:00Z'),
      now,
    );
    const coordinator = yield* makeAccountRuntimeCoordinator(paths, config, journal, {
      now: () => now,
      openAccount: (account) => Effect.succeed(fakeRuntime(account.id)),
      readProvider: Effect.succeed(null),
    });
    const acquire = yield* Effect.forkChild(coordinator.acquire);
    const waiting = yield* Effect.repeat(
      Effect.yieldNow.pipe(Effect.andThen(coordinator.snapshot)),
      { times: 1000, until: (state) => state.kind === 'WaitingForCapacity' },
    );
    expect(waiting).toEqual({
      kind: 'WaitingForCapacity',
      retryAt: new Date('2026-07-14T17:00:00Z'),
    });

    yield* coordinator.add('beta', credential(root, 'b'));
    const runtime = yield* Fiber.join(acquire);
    expect(runtime.accountId).toBe('beta');
    const serialized = JSON.stringify(yield* coordinator.list);
    expect(serialized).not.toContain('secret-');
    expect(serialized).not.toContain('auth.json');

    yield* coordinator.release(runtime);
    yield* coordinator.close;
    handle.close();
  }),
);

it.effect('records a capacity failure and rotates to the next eligible account', () =>
  Effect.gen(function* openFailureFixture() {
    const { config, paths, root } = fixture();
    yield* ensureRuntimeLayout(paths);
    yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'alpha', credential(root, 'a'));
    yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'beta', credential(root, 'b'));
    const handle = yield* openJournal(paths.database);
    const journal = makeCodexJournal(handle.database);
    const coordinator = yield* makeAccountRuntimeCoordinator(paths, config, journal, {
      openAccount: (account) =>
        account.id === 'alpha'
          ? Effect.fail(
              new CodexRuntimeError({
                cause: { status: 429 },
                message: 'rate limit exhausted',
                operation: 'initialize',
              }),
            )
          : Effect.succeed(fakeRuntime(account.id)),
      readProvider: Effect.succeed(null),
    });

    const runtime = yield* coordinator.acquire;
    expect(runtime.accountId).toBe('beta');
    expect(yield* journal.loadAccountObservations).toMatchObject([
      { accountId: 'alpha', mode: 'Capacity' },
      { accountId: 'beta' },
    ]);

    yield* coordinator.release(runtime);
    yield* coordinator.close;
    handle.close();
  }),
);

it.effect('records an authentication failure and rotates to the next eligible account', () =>
  Effect.gen(function* authenticationFailureFixture() {
    const { config, paths, root } = fixture();
    yield* ensureRuntimeLayout(paths);
    yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'alpha', credential(root, 'a'));
    yield* addStoredAccount({ accountsDirectory: paths.accounts }, 'beta', credential(root, 'b'));
    const handle = yield* openJournal(paths.database);
    const journal = makeCodexJournal(handle.database);
    const coordinator = yield* makeAccountRuntimeCoordinator(paths, config, journal, {
      openAccount: (account) =>
        account.id === 'alpha'
          ? Effect.fail(
              new CodexRuntimeError({
                cause: { status: 401 },
                message: 'authentication required',
                operation: 'initialize',
              }),
            )
          : Effect.succeed(fakeRuntime(account.id)),
      readProvider: Effect.succeed(null),
    });

    const runtime = yield* coordinator.acquire;
    expect(runtime.accountId).toBe('beta');
    expect(yield* journal.loadAccountObservations).toMatchObject([
      { accountId: 'alpha', mode: 'Authentication' },
      { accountId: 'beta' },
    ]);

    yield* coordinator.release(runtime);
    yield* coordinator.close;
    handle.close();
  }),
);
