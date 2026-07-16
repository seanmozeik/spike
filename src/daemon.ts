import { once } from 'node:events';
import { appendFile, rm } from 'node:fs/promises';
import type { Server } from 'node:net';
import path from 'node:path';

import { Deferred, Effect } from 'effect';

import { loadSpikeConfig, type SpikeConfig } from './app-config';
import { openCodexRuntime, type CodexRuntime } from './codex/runtime';
import { ensureRuntimeLayout } from './config-files';
import { startControlSocket } from './control-socket';
import { openJournal, type JournalHandle } from './database';
import { makeDeliveryJournal } from './delivery/journal';
import { openMessagesTransport, type MessagesTransport } from './delivery/messages-transport';
import { makeDeliveryService } from './delivery/service';
import { SpikeRuntimeError } from './errors';
import { makeDisabledLikeAcknowledgement, makeLikeAcknowledgement } from './like/adapter';
import { makeLikeJournal } from './like/journal';
import { makeLikeNativeRunner } from './like/native-runner';
import { openMessagesInbox, type MessagesInboxHandle } from './messages-inbox';
import type { SpikePaths } from './paths';
import { makeSpikeEngine, type SpikeEngine } from './service/engine';
import { makeDoctorReport } from './status/doctor';
import { formatStatus } from './status/format';
import { makeStatusSnapshot } from './status/snapshot';

const waitForSignal = Effect.callback<boolean>((resume) => {
  const stop = (): void => {
    resume(Effect.succeed(true));
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

interface ServeDaemonOptions {
  readonly codex?: boolean;
}

const acquireCodex = (
  paths: SpikePaths,
  config: SpikeConfig,
  enabled: boolean,
): Effect.Effect<CodexRuntime | null, SpikeRuntimeError> =>
  enabled
    ? openCodexRuntime(paths, config).pipe(
        Effect.mapError(
          (cause) =>
            new SpikeRuntimeError({
              cause,
              message: 'failed to start supervised Codex runtime',
              operation: 'start-codex-runtime',
            }),
        ),
      )
    : Effect.succeed(null);

const releaseCodex = (runtime: CodexRuntime | null): Effect.Effect<void> =>
  runtime === null ? Effect.void : Effect.promise(runtime.close);

const releaseInbox = (inbox: MessagesInboxHandle): Effect.Effect<void> => Effect.sync(inbox.close);

const releaseTransport = (transport: MessagesTransport): Effect.Effect<void> =>
  Effect.sync(transport.close);

const releaseEngine = (engine: SpikeEngine): Effect.Effect<void> => Effect.sync(engine.close);

const likeHelperPath = (): string =>
  process.env['SPIKE_LIKE_HELPER'] ??
  path.join(path.dirname(process.argv[1] ?? import.meta.filename), 'spike-like');

const reportLikeFailure = (error: unknown): void => {
  const message = String(error);
  process.stderr.write(`Like ${message}\n`);
};

const resourceError =
  (operation: string, message: string) =>
  (cause: unknown): SpikeRuntimeError =>
    new SpikeRuntimeError({ cause, message, operation });

const acquireInbox = (
  config: SpikeConfig,
  enabled: boolean,
): Effect.Effect<MessagesInboxHandle | null, SpikeRuntimeError> =>
  enabled
    ? openMessagesInbox({
        chatGuid: config.chatGuid,
        databasePath: config.messagesDatabase,
        handle: config.handle,
      }).pipe(Effect.mapError(resourceError('open-inbox', 'failed to open Messages inbox')))
    : Effect.succeed(null);

const acquireTransport = (
  config: SpikeConfig,
  enabled: boolean,
): Effect.Effect<MessagesTransport | null, SpikeRuntimeError> =>
  enabled
    ? openMessagesTransport(config.messagesDatabase, config.chatGuid).pipe(
        Effect.mapError(resourceError('open-transport', 'failed to open Messages transport')),
      )
    : Effect.succeed(null);

const acquireEngine = Effect.fn('SpikeDaemon.acquireEngine')(function* acquireEngine(
  paths: SpikePaths,
  config: SpikeConfig,
  journal: JournalHandle,
  runtime: CodexRuntime | null,
  startedAt: string,
  enabled: boolean,
) {
  const inbox = yield* Effect.acquireRelease(acquireInbox(config, enabled), (resource) =>
    resource === null ? Effect.void : releaseInbox(resource),
  );
  const transport = yield* Effect.acquireRelease(acquireTransport(config, enabled), (resource) =>
    resource === null ? Effect.void : releaseTransport(resource),
  );
  if (runtime === null || inbox === null || transport === null) {
    return null;
  }
  const delivery = makeDeliveryService(makeDeliveryJournal(journal.database), transport);
  const likeJournal = makeLikeJournal(journal.database);
  const likeRunner = makeLikeNativeRunner(config.handle, likeHelperPath());
  const like = config.likeAcknowledgements
    ? makeLikeAcknowledgement(likeJournal, likeRunner, { report: reportLikeFailure })
    : makeDisabledLikeAcknowledgement(likeJournal);
  return yield* makeSpikeEngine({
    chatGuid: config.chatGuid,
    database: journal.database,
    delivery,
    inbox,
    like,
    renderStatus: async () =>
      formatStatus(await makeStatusSnapshot(journal.database, paths, startedAt, runtime)),
    runtime,
  });
});

const serveDaemon = Effect.fn('SpikeDaemon.serve')(
  (paths: SpikePaths, options: ServeDaemonOptions = {}) =>
    Effect.gen(function* serveDaemonScoped() {
      yield* ensureRuntimeLayout(paths);
      const config = yield* loadSpikeConfig(paths);
      const journal = yield* Effect.acquireRelease(openJournal(paths.database), releaseJournal);
      const runtime = yield* Effect.acquireRelease(
        acquireCodex(paths, config, options.codex !== false),
        releaseCodex,
      );
      const startedAt = new Date().toISOString();
      const engine = yield* Effect.acquireRelease(
        acquireEngine(paths, config, journal, runtime, startedAt, options.codex !== false),
        (resource) => (resource === null ? Effect.void : releaseEngine(resource)),
      );
      if (engine !== null) {
        yield* engine.redactNow(new Date());
        yield* Effect.forkChild(engine.run);
      }
      const controlStop = yield* Deferred.make<boolean>();
      const status = (): ReturnType<typeof makeStatusSnapshot> =>
        makeStatusSnapshot(journal.database, paths, startedAt, runtime);
      yield* Effect.acquireRelease(
        Effect.promise(() =>
          startControlSocket(
            paths,
            startedAt,
            () => {
              Deferred.doneUnsafe(controlStop, Effect.succeed(true));
            },
            status,
            async () => makeDoctorReport(paths, await status(), likeHelperPath()),
          ),
        ),
        (server) => releaseServer(server, paths),
      );
      yield* Effect.promise(() =>
        appendFile(paths.daemonLog, `${startedAt} started pid=${process.pid}\n`, 'utf8'),
      );
      yield* Effect.race(waitForSignal, Deferred.await(controlStop));
    }).pipe(Effect.scoped),
);

export { serveDaemon };
export type { ServeDaemonOptions };
