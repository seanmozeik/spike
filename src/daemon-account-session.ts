import { appendFile } from 'node:fs/promises';
import path from 'node:path';

import { Deferred, Effect, Fiber, type Scope } from 'effect';

import type { SpikeConfig } from './app-config';
import { attachmentRoots } from './attachments/roots';
import type { AccountRuntimeCoordinator } from './codex/account-runtime-coordinator';
import type { CodexRuntime } from './codex/runtime';
import { makeConversationPolicy } from './conversation-policy';
import type { JournalHandle } from './database';
import { makeDeliveryJournal } from './delivery/journal';
import {
  openMessagesTransport,
  type MessagesTransport,
  withConversationAvailability,
} from './delivery/messages-transport';
import { makeDeliveryService } from './delivery/service';
import { SpikeRuntimeError } from './errors';
import { makeConversationDiagnostic } from './journal/conversation-diagnostic';
import { makeJournal } from './journal/service';
import {
  makeDisabledLikeAcknowledgement,
  makeLikeAcknowledgement,
  type LikeAcknowledgement,
} from './like/adapter';
import { makeLikeJournal } from './like/journal';
import { makeLikeNativeRunner } from './like/native-runner';
import { openMessagesInbox, type MessagesInboxHandle } from './messages-inbox';
import { makeMessagesWatcher } from './messages-watcher';
import type { OutageService } from './outage/service';
import type { SpikePaths } from './paths';
import { makeSpikeEngine, type SpikeEngine } from './service/engine';
import type { EngineEventLoopDiagnostics } from './service/event-loop-diagnostics';
import { formatStatus } from './status/format';
import { makeStatusSnapshot } from './status/snapshot';

type SessionEnd = 'CodexConnectionClosed' | 'RotateAccount';

interface AccountSessionOptions {
  readonly conversationValidationIntervalMs?: number;
}

interface AccountSessionDependencies {
  readonly config: SpikeConfig;
  readonly coordinator: AccountRuntimeCoordinator;
  readonly diagnosticsSlot: EngineDiagnosticsSlot;
  readonly journal: JournalHandle;
  readonly options: AccountSessionOptions;
  readonly outages: OutageService;
  readonly paths: SpikePaths;
  readonly runtimeSlot: RuntimeSlot;
  readonly startedAt: string;
}

interface RuntimeSlot {
  value: CodexRuntime | null;
}

interface EngineDiagnosticsSlot {
  read: (() => EngineEventLoopDiagnostics) | null;
}

interface AcquireEngineContext {
  readonly config: SpikeConfig;
  readonly diagnosticsSlot: EngineDiagnosticsSlot;
  readonly journal: JournalHandle;
  readonly options: AccountSessionOptions;
  readonly paths: SpikePaths;
  readonly runtime: CodexRuntime;
  readonly startedAt: string;
}

const releaseInbox = (inbox: MessagesInboxHandle): Effect.Effect<void> => Effect.sync(inbox.close);
const releaseTransport = (transport: MessagesTransport): Effect.Effect<void> =>
  Effect.sync(transport.close);
const releaseEngine = (engine: SpikeEngine): Effect.Effect<void> =>
  engine.shutdown.pipe(Effect.ignoreCause);

const likeHelperPath = (): string =>
  process.env['SPIKE_LIKE_HELPER'] ??
  path.join(path.dirname(process.argv[1] ?? import.meta.filename), 'spike-like');

const resourceError =
  (operation: string, message: string) =>
  (cause: unknown): SpikeRuntimeError =>
    new SpikeRuntimeError({ cause, message, operation });

const acquireInbox = (config: SpikeConfig): Effect.Effect<MessagesInboxHandle, SpikeRuntimeError> =>
  openMessagesInbox({
    chatGuid: config.chatGuid,
    databasePath: config.messagesDatabase,
    handle: config.handle,
  }).pipe(Effect.mapError(resourceError('open-inbox', 'failed to open Messages inbox')));

const acquireTransport = (
  config: SpikeConfig,
): Effect.Effect<MessagesTransport, SpikeRuntimeError> =>
  openMessagesTransport(config.messagesDatabase, config).pipe(
    Effect.mapError(resourceError('open-transport', 'failed to open Messages transport')),
  );

const initializeInboxFrontier = (
  config: SpikeConfig,
  journal: JournalHandle,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* initializeDurableFrontier() {
    const inbox = yield* Effect.acquireRelease(acquireInbox(config), releaseInbox);
    const messages = makeJournal(journal.database, {
      chatGuid: config.chatGuid,
      handle: config.handle,
    });
    if ((yield* messages.inboxCursor(config.chatGuid)) === null) {
      yield* messages.initializeInboxCursor(config.chatGuid, yield* inbox.frontier, new Date());
    }
  }).pipe(Effect.scoped);

const makeConfiguredLikeAcknowledgement = (
  config: SpikeConfig,
  journal: JournalHandle,
): LikeAcknowledgement => {
  const likeJournal = makeLikeJournal(journal.database);
  return config.likeAcknowledgements
    ? makeLikeAcknowledgement(likeJournal, makeLikeNativeRunner(config.handle, likeHelperPath()), {
        report: (error): void => {
          process.stderr.write(`Like ${String(error)}\n`);
        },
      })
    : makeDisabledLikeAcknowledgement(likeJournal);
};

const acquireEngine = Effect.fn('SpikeDaemon.acquireEngine')(function* acquireEngine(
  context: AcquireEngineContext,
) {
  const { config, diagnosticsSlot, journal, options, paths, runtime, startedAt } = context;
  const inbox = yield* Effect.acquireRelease(acquireInbox(config), releaseInbox);
  const transport = yield* Effect.acquireRelease(acquireTransport(config), releaseTransport);
  const conversation = yield* makeConversationPolicy({
    diagnostic: makeConversationDiagnostic(journal.database),
    initialValidationAt: new Date(startedAt),
    probe: () => inbox.refresh.pipe(Effect.andThen(transport.refresh)),
    ...(options.conversationValidationIntervalMs === undefined
      ? {}
      : { validationIntervalMs: options.conversationValidationIntervalMs }),
  });
  const delivery = makeDeliveryService(
    makeDeliveryJournal(journal.database),
    withConversationAvailability(transport, conversation),
  );
  return yield* makeSpikeEngine({
    ...attachmentRoots(config.messagesDatabase, paths.attachments),
    chatGuid: config.chatGuid,
    conversation,
    database: journal.database,
    delivery,
    handle: config.handle,
    inbox,
    like: makeConfiguredLikeAcknowledgement(config, journal),
    renderStatus: async () =>
      formatStatus(
        await makeStatusSnapshot(
          journal.database,
          paths,
          startedAt,
          runtime,
          diagnosticsSlot.read?.() ?? null,
        ),
      ),
    runtime,
    watchMessages: makeMessagesWatcher(config.messagesDatabase),
  });
});

const runEngine = (engine: SpikeEngine): Effect.Effect<Fiber.Fiber<never>, unknown> =>
  Effect.gen(function* startEventLoop() {
    yield* engine.redactNow(new Date());
    return yield* Effect.forkChild(engine.run);
  });

const subscribeRuntimeStop = (
  runtime: CodexRuntime,
  stopped: Deferred.Deferred<SessionEnd>,
): Effect.Effect<() => void> =>
  Effect.sync(() =>
    runtime.addConnectionCloseListener(() => {
      Deferred.doneUnsafe(stopped, Effect.succeed('CodexConnectionClosed'));
    }),
  );

const drainAfterCodexClose = (engine: SpikeEngine, paths: SpikePaths): Effect.Effect<void> =>
  Effect.gen(function* drainForRestart() {
    yield* Effect.promise(() =>
      appendFile(
        paths.daemonLog,
        `${new Date().toISOString()} codex app-server connection closed; stopping daemon\n`,
        'utf8',
      ),
    );
    yield* engine.drain;
  });

const bindRuntimeSlot = (
  slot: RuntimeSlot,
  runtime: CodexRuntime,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      slot.value = runtime;
    }),
    () =>
      Effect.sync(() => {
        slot.value = null;
      }),
  );

const bindDiagnosticsSlot = (
  slot: EngineDiagnosticsSlot,
  engine: SpikeEngine,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      slot.read = engine.readEventLoopDiagnostics;
    }),
    () =>
      Effect.sync(() => {
        slot.read = null;
      }),
  );

const runAccountSession = (
  dependencies: AccountSessionDependencies,
): Effect.Effect<SessionEnd, unknown> =>
  Effect.gen(function* accountSession() {
    const {
      config,
      coordinator,
      diagnosticsSlot,
      journal,
      options,
      outages,
      paths,
      runtimeSlot,
      startedAt,
    } = dependencies;
    const runtime = yield* Effect.acquireRelease(coordinator.acquire, (activeRuntime) =>
      coordinator.release(activeRuntime),
    );
    yield* bindRuntimeSlot(runtimeSlot, runtime);
    const engine = yield* Effect.acquireRelease(
      acquireEngine({ config, diagnosticsSlot, journal, options, paths, runtime, startedAt }),
      releaseEngine,
    );
    yield* bindDiagnosticsSlot(diagnosticsSlot, engine);
    const childStopped = yield* Deferred.make<SessionEnd>();
    yield* Effect.acquireRelease(subscribeRuntimeStop(runtime, childStopped), (unsubscribe) =>
      Effect.sync(unsubscribe),
    );
    const engineRun = yield* Effect.acquireRelease(runEngine(engine), Fiber.interrupt);
    const end = yield* Effect.race(
      Deferred.await(childStopped),
      engine.accountUnavailable.pipe(Effect.as<SessionEnd>('RotateAccount')),
    );
    if (end === 'RotateAccount') {
      engine.close();
      yield* Fiber.interrupt(engineRun);
      return end;
    }
    yield* outages.runtimeUnavailable(new Date());
    engine.quiesce();
    yield* Fiber.interrupt(engineRun);
    yield* drainAfterCodexClose(engine, paths);
    return end;
  }).pipe(Effect.scoped);

const superviseAccounts = Effect.fn('SpikeDaemon.superviseAccounts')(function* superviseAccounts(
  dependencies: AccountSessionDependencies,
) {
  let end = yield* runAccountSession(dependencies);
  while (end === 'RotateAccount') {
    yield* dependencies.coordinator.wake;
    end = yield* runAccountSession(dependencies);
  }
  return end;
});

export { initializeInboxFrontier, likeHelperPath, superviseAccounts };
export type { AccountSessionOptions, EngineDiagnosticsSlot, RuntimeSlot };
