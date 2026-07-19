import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect, Result } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import {
  type MessagesDatabaseEvent,
  MessagesWatcherError,
  openMessagesWatcher,
  type WatchHandle,
  type WatchListener,
  type WatchPath,
} from '../src/messages-watcher';

const roots: string[] = [];

class FakeWatchHandle implements WatchHandle {
  closed = false;
  private readonly errorListeners: ((cause: Error) => void)[] = [];

  close(): void {
    this.closed = true;
  }

  fail(cause: Error): void {
    for (const listener of this.errorListeners) {
      listener(cause);
    }
  }

  on(_event: 'error', listener: (cause: Error) => void): WatchHandle {
    this.errorListeners.push(listener);
    return this;
  }
}

interface FakeWatchCall {
  readonly handle: FakeWatchHandle;
  readonly listener: WatchListener;
  readonly target: string;
}

const makeFakeWatchPath = (): {
  readonly calls: FakeWatchCall[];
  readonly watchPath: WatchPath;
} => {
  const calls: FakeWatchCall[] = [];
  return {
    calls,
    watchPath: (target, listener): WatchHandle => {
      const handle = new FakeWatchHandle();
      calls.push({ handle, listener, target });
      return handle;
    },
  };
};

const latestCall = (calls: readonly FakeWatchCall[], target: string): FakeWatchCall => {
  const call = calls.findLast((candidate) => candidate.target === target);
  if (call === undefined) {
    throw new Error(`no watcher call for ${target}`);
  }
  return call;
};

const unexpectedCallback = (): never => {
  throw new Error('watch callback ran before watcher acquisition');
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const makeDatabasePath = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-messages-watch-'));
  roots.push(root);
  const databasePath = path.join(root, 'chat.db');
  writeFileSync(databasePath, 'database');
  return databasePath;
};

const waitForNextEvent = async (events: { value: number }, after: number): Promise<void> => {
  await vi.waitFor(() => {
    expect(events.value).toBeGreaterThan(after);
  });
};

const exerciseSidecarReplacement = async (
  databasePath: string,
  suffix: '-shm' | '-wal',
  events: { value: number },
): Promise<void> => {
  const sidecar = `${databasePath}${suffix}`;
  let before = events.value;
  writeFileSync(sidecar, 'first');
  await waitForNextEvent(events, before);
  await Bun.sleep(20);
  before = events.value;
  appendFileSync(sidecar, '-write');
  await waitForNextEvent(events, before);
  renameSync(sidecar, `${sidecar}.rotated`);
  writeFileSync(sidecar, 'replacement');
  await Bun.sleep(20);
  before = events.value;
  appendFileSync(sidecar, '-replacement-write');
  await waitForNextEvent(events, before);
};

it('observes database writes and re-arms WAL, SHM, and database replacements', async () => {
  const databasePath = makeDatabasePath();
  const events = { value: 0 };
  const errors: MessagesWatcherError[] = [];
  const watcher = await Effect.runPromise(
    openMessagesWatcher(databasePath, {
      onError: (error) => {
        errors.push(error);
      },
      onEvent: () => {
        events.value += 1;
      },
    }),
  );
  try {
    let before = events.value;
    appendFileSync(databasePath, '-write');
    await waitForNextEvent(events, before);

    await exerciseSidecarReplacement(databasePath, '-wal', events);
    await exerciseSidecarReplacement(databasePath, '-shm', events);

    renameSync(databasePath, `${databasePath}.replaced`);
    writeFileSync(databasePath, 'replacement');
    await Bun.sleep(20);
    before = events.value;
    appendFileSync(databasePath, '-replacement-write');
    await waitForNextEvent(events, before);

    expect(errors).toStrictEqual([]);
    expect(watcher.diagnostics()).toMatchObject({
      closed: false,
      databasePath,
      lastError: null,
      watchedFiles: ['chat.db', 'chat.db-journal', 'chat.db-shm', 'chat.db-wal'],
    });
  } finally {
    watcher.close();
  }
  expect(watcher.diagnostics()).toMatchObject({ activeFileWatchers: 0, closed: true });
});

it('returns a structured failure when the database directory cannot be watched', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-messages-watch-missing-'));
  roots.push(root);
  const databasePath = path.join(root, 'missing', 'chat.db');
  const opening = openMessagesWatcher(databasePath, {
    onError: unexpectedCallback,
    onEvent: unexpectedCallback,
  });
  const result = await Effect.runPromise(Effect.result(opening));
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(MessagesWatcherError);
    expect(result.failure).toMatchObject({ operation: 'watch-directory' });
  }
});

it('isolates stale watcher errors and restarts after a current runtime ENOENT', async () => {
  const databasePath = '/fixture/chat.db';
  const fake = makeFakeWatchPath();
  const events: MessagesDatabaseEvent[] = [];
  const errors: MessagesWatcherError[] = [];
  const watcher = await Effect.runPromise(
    openMessagesWatcher(
      databasePath,
      {
        onError: (error) => {
          errors.push(error);
        },
        onEvent: (event) => {
          events.push(event);
        },
      },
      { restartDelayMs: 0, watchPath: fake.watchPath },
    ),
  );
  try {
    const oldDatabase = latestCall(fake.calls, databasePath);
    latestCall(fake.calls, '/fixture').listener('rename', 'chat.db');
    const currentDatabase = latestCall(fake.calls, databasePath);
    expect(currentDatabase).not.toBe(oldDatabase);
    expect(events).toStrictEqual([{ kind: 'DatabaseReplaced' }]);

    oldDatabase.handle.fail(Object.assign(new Error('stale watcher vanished'), { code: 'ENOENT' }));
    expect(errors).toStrictEqual([]);
    expect(watcher.diagnostics().activeFileWatchers).toBe(4);

    currentDatabase.handle.fail(
      Object.assign(new Error('current watcher vanished'), { code: 'ENOENT' }),
    );
    expect(errors).toHaveLength(1);
    expect(watcher.diagnostics()).toMatchObject({ activeFileWatchers: 3, restartScheduled: true });
    await vi.waitFor(() => {
      expect(watcher.diagnostics()).toMatchObject({
        activeFileWatchers: 4,
        restartCount: 1,
        restartScheduled: false,
      });
    });
  } finally {
    watcher.close();
  }
});

it('re-arms the directory watcher after a runtime failure', async () => {
  const fake = makeFakeWatchPath();
  const errors: MessagesWatcherError[] = [];
  const watcher = await Effect.runPromise(
    openMessagesWatcher(
      '/fixture/chat.db',
      {
        onError: (error) => {
          errors.push(error);
        },
        onEvent: unexpectedCallback,
      },
      { restartDelayMs: 0, watchPath: fake.watchPath },
    ),
  );
  try {
    const directory = latestCall(fake.calls, '/fixture');
    directory.handle.fail(new Error('directory watcher failed'));
    expect(errors).toHaveLength(1);
    expect(watcher.diagnostics()).toMatchObject({
      activeDirectoryWatcher: false,
      restartScheduled: true,
    });
    await vi.waitFor(() => {
      expect(latestCall(fake.calls, '/fixture')).not.toBe(directory);
      expect(watcher.diagnostics()).toMatchObject({
        activeDirectoryWatcher: true,
        restartCount: 1,
        restartScheduled: false,
      });
    });
  } finally {
    watcher.close();
  }
});
