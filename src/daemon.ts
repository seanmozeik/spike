import { once } from 'node:events';
import { appendFile, rm } from 'node:fs/promises';
import type { Server } from 'node:net';

import { Deferred, Effect } from 'effect';

import { loadSpikeConfig } from './app-config';
import {
  makeAccountRuntimeCoordinator,
  type AccountRuntimeCoordinator,
} from './codex/account-runtime-coordinator';
import type { CodexLogMode } from './codex/stderr-log';
import { ensureRuntimeLayout } from './config-files';
import { startControlSocket } from './control-socket';
import {
  initializeInboxFrontier,
  likeHelperPath,
  superviseAccounts,
  type AccountSessionOptions,
  type RuntimeSlot,
} from './daemon-account-session';
import { openJournal, type JournalHandle } from './database';
import { makeCodexJournal } from './journal/codex-journal';
import type { SpikePaths } from './paths';
import { readApprovalList } from './status/approvals';
import { makeDoctorReport } from './status/doctor';
import { makeStatusSnapshot } from './status/snapshot';

type DaemonStopReason = 'CodexConnectionClosed' | 'Control';

interface ServeDaemonOptions extends AccountSessionOptions {
  readonly codex?: boolean;
  readonly logMode?: CodexLogMode;
}

const waitForSignal = Effect.callback<DaemonStopReason>((resume) => {
  const stop = (): void => {
    resume(Effect.succeed('Control'));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return Effect.sync(() => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  });
});

const closeServer = async (server: Server): Promise<void> => {
  const closed = once(server, 'close');
  server.close();
  await closed;
};

const releaseJournal = (journal: JournalHandle): Effect.Effect<void> =>
  Effect.sync(() => {
    journal.close();
  });

const releaseServer = (server: Server, paths: SpikePaths): Effect.Effect<void> =>
  Effect.promise(async () => {
    try {
      await closeServer(server);
    } finally {
      await rm(paths.socket, { force: true });
      await appendFile(paths.daemonLog, `${new Date().toISOString()} stopped\n`, 'utf8');
    }
  });

interface ControlServerContext {
  readonly coordinator: AccountRuntimeCoordinator;
  readonly journal: JournalHandle;
  readonly paths: SpikePaths;
  readonly runtimeSlot: RuntimeSlot;
  readonly startedAt: string;
  readonly stop: Deferred.Deferred<DaemonStopReason>;
}

const acquireControlServer = (context: ControlServerContext): Effect.Effect<Server> => {
  const { coordinator, journal, paths, runtimeSlot, startedAt, stop } = context;
  const status = (): ReturnType<typeof makeStatusSnapshot> =>
    makeStatusSnapshot(journal.database, paths, startedAt, runtimeSlot.value);
  return Effect.promise(() =>
    startControlSocket(
      paths,
      startedAt,
      () => {
        Deferred.doneUnsafe(stop, Effect.succeed('Control'));
      },
      status,
      async () => makeDoctorReport(paths, await status(), likeHelperPath()),
      () => Promise.resolve(readApprovalList(journal.database)),
      {
        add: (accountId, sourcePath) => Effect.runPromise(coordinator.add(accountId, sourcePath)),
        list: () => Effect.runPromise(coordinator.list),
      },
    ),
  );
};

const serveDaemon = Effect.fn('SpikeDaemon.serve')(
  (paths: SpikePaths, options: ServeDaemonOptions = {}) =>
    Effect.gen(function* serveDaemonScoped() {
      yield* ensureRuntimeLayout(paths);
      const config = yield* loadSpikeConfig(paths);
      const journal = yield* Effect.acquireRelease(openJournal(paths.database), releaseJournal);
      const coordinator = yield* Effect.acquireRelease(
        makeAccountRuntimeCoordinator(paths, config, makeCodexJournal(journal.database), {
          logMode: options.logMode ?? 'quiet',
        }),
        (resource) => resource.close,
      );
      if (options.codex !== false) {
        yield* initializeInboxFrontier(config, journal);
      }
      const startedAt = new Date().toISOString();
      const runtimeSlot: RuntimeSlot = { value: null };
      const stop = yield* Deferred.make<DaemonStopReason>();
      yield* Effect.acquireRelease(
        acquireControlServer({ coordinator, journal, paths, runtimeSlot, startedAt, stop }),
        (server) => releaseServer(server, paths),
      );
      yield* Effect.promise(() =>
        appendFile(paths.daemonLog, `${startedAt} started pid=${process.pid}\n`, 'utf8'),
      );
      const control = Effect.race(waitForSignal, Deferred.await(stop));
      if (options.codex === false) {
        yield* control;
        return;
      }
      yield* Effect.raceFirst(
        control,
        superviseAccounts({ config, coordinator, journal, options, paths, runtimeSlot, startedAt }),
      );
    }).pipe(Effect.scoped),
);

export { serveDaemon };
export type { ServeDaemonOptions };
