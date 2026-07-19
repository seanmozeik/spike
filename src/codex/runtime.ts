import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Effect, Result } from 'effect';

import type { SpikeConfig } from '../app-config';
import { CodexThreadId, CodexTurnId } from '../domain/ids';
import { CodexRuntimeError } from '../errors';
import { isObject } from '../object-guard';
import type { SpikePaths } from '../paths';
import { scheduleDynamicTools } from '../schedule/tool-spec';
import { assembleSystemPrompt } from '../system-prompt';
import { activateAccount, type AccountPoolOptions, type AccountRecord } from './account-pool';
import type { ClassifiedOutput } from './output-classifier';
import type { ThreadItem, ThreadSnapshot, ThreadTurn } from './reconcile';
import { initializeRpc, spawnRpcHandle, type RpcHandle } from './rpc';
import type { CodexRuntime } from './runtime-types';
import type { CodexLogMode } from './stderr-log';
import { classifyThreadLookup, isThreadNotLoaded } from './thread-errors';
import { waitForTurn } from './turn-wait';

const HEALTH_RPC_TIMEOUT_MS = 700;
const STATUS_RPC_TIMEOUT_MS = 2000;

const customProvider = async (codexHome: string): Promise<null | string> => {
  const config: unknown = Bun.TOML.parse(
    await readFile(path.join(codexHome, 'config.toml'), 'utf8'),
  );
  if (!isObject(config)) {
    return null;
  }
  const provider = config['model_provider'];
  return typeof provider === 'string' && provider !== '' && provider !== 'openai' ? provider : null;
};

const runtimeError = (operation: string, cause: unknown): CodexRuntimeError =>
  new CodexRuntimeError({ cause, message: `Codex ${operation} failed`, operation });

const spawnAppServer = Effect.fn('SpikeCodex.spawnAppServer')(
  (paths: SpikePaths, config: SpikeConfig, logMode: CodexLogMode) =>
    Effect.try({
      catch: (cause) =>
        new CodexRuntimeError({
          cause,
          message: 'failed to spawn Codex app-server',
          operation: 'spawn',
        }),
      try: () =>
        spawnRpcHandle({
          codexExecutable: config.codexExecutable,
          codexHome: config.codexHome,
          logMode,
          stderrLog: paths.daemonLog,
        }),
    }),
);

const request = (
  handle: RpcHandle,
  operation: string,
  params?: unknown,
  timeoutMs?: number,
): Effect.Effect<unknown, CodexRuntimeError> =>
  Effect.tryPromise({
    catch: (cause) => runtimeError(operation, cause),
    try: () => handle.request(operation, params, timeoutMs),
  });

const responseId = (
  operation: string,
  response: unknown,
  field: 'thread' | 'turn',
): Effect.Effect<string, CodexRuntimeError> => {
  if (
    isObject(response) &&
    isObject(response[field]) &&
    typeof response[field]['id'] === 'string'
  ) {
    return Effect.succeed(response[field]['id']);
  }
  return Effect.fail(runtimeError(operation, response));
};

const parseThreadItem = (value: unknown): ThreadItem | null => {
  if (!isObject(value) || typeof value['id'] !== 'string' || typeof value['type'] !== 'string') {
    return null;
  }
  const { clientId } = value;
  return {
    ...(typeof clientId === 'string' || clientId === null ? { clientId } : {}),
    id: value['id'],
    ...(typeof value['phase'] === 'string' || value['phase'] === null
      ? { phase: value['phase'] }
      : {}),
    ...(typeof value['text'] === 'string' ? { text: value['text'] } : {}),
    type: value['type'],
  };
};

const parseTurn = (value: unknown): ThreadTurn | null => {
  if (!isObject(value) || typeof value['id'] !== 'string' || !Array.isArray(value['items'])) {
    return null;
  }
  return {
    ...('error' in value ? { error: value['error'] } : {}),
    id: value['id'],
    items: value['items'].map(parseThreadItem).filter((item): item is ThreadItem => item !== null),
    ...(typeof value['status'] === 'string' ? { status: value['status'] } : {}),
  };
};

const parseThread = (response: unknown): Effect.Effect<ThreadSnapshot, CodexRuntimeError> => {
  const thread = isObject(response) ? response['thread'] : null;
  if (!isObject(thread) || typeof thread['id'] !== 'string' || !Array.isArray(thread['turns'])) {
    return Effect.fail(runtimeError('thread/read', response));
  }
  return Effect.succeed({
    id: thread['id'],
    turns: thread['turns'].map(parseTurn).filter((turn): turn is ThreadTurn => turn !== null),
  });
};

const parseLoadedThreads = (
  response: unknown,
): Effect.Effect<readonly CodexThreadId[], CodexRuntimeError> => {
  const data = isObject(response) ? response['data'] : null;
  return Array.isArray(data)
    ? Effect.succeed(
        data
          .filter((value): value is string => typeof value === 'string')
          .map((id) => CodexThreadId.make(id)),
      )
    : Effect.fail(runtimeError('thread/loaded/list', response));
};

const threadStartParams = (prompt: string, workingDirectory: string): Record<string, unknown> => ({
  baseInstructions: prompt,
  config: {
    'features.current_time_reminder.clock_source': 'external',
    'features.current_time_reminder.delivery_mode': 'after_user_or_tool_output',
    'features.current_time_reminder.enabled': true,
    'features.current_time_reminder.reminder_interval_seconds': 0,
  },
  cwd: workingDirectory,
  dynamicTools: scheduleDynamicTools,
  historyMode: 'legacy',
});

const userInput = (
  text: string,
  attachments: Parameters<CodexRuntime['startTurn']>[0]['attachments'],
): readonly Record<string, unknown>[] => [
  { text, text_elements: [], type: 'text' },
  ...attachments.map((attachment) => ({ path: attachment.path, type: 'localImage' })),
];

const readThread = Effect.fn('SpikeCodex.readThread')(function* readThread(
  handle: RpcHandle,
  workingDirectory: string,
  threadId: CodexThreadId,
) {
  const requestRead = request(handle, 'thread/read', { includeTurns: true, threadId }).pipe(
    Effect.flatMap(parseThread),
  );
  const first = yield* Effect.result(requestRead);
  if (Result.isSuccess(first)) {
    return first.success;
  }
  if (!isThreadNotLoaded(first.failure)) {
    return yield* first.failure;
  }
  yield* request(handle, 'thread/resume', { cwd: workingDirectory, threadId });
  return yield* requestRead;
});

const threadMethods = (
  handle: RpcHandle,
  workingDirectory: string,
): Pick<CodexRuntime, 'readThread' | 'resumeThread'> => ({
  readThread: (threadId): ReturnType<CodexRuntime['readThread']> =>
    classifyThreadLookup(readThread(handle, workingDirectory, threadId)),
  resumeThread: (threadId): ReturnType<CodexRuntime['resumeThread']> =>
    classifyThreadLookup(
      request(handle, 'thread/resume', { cwd: workingDirectory, threadId }).pipe(Effect.asVoid),
    ),
});

const makeCodexRuntime = (
  handle: RpcHandle,
  prompt: string,
  accountId: string,
  workingDirectory: string,
): CodexRuntime => ({
  ...threadMethods(handle, workingDirectory),
  accountId,
  addConnectionCloseListener: handle.addConnectionCloseListener,
  addNotificationListener: handle.addNotificationListener,
  addServerRequestListener: handle.addServerRequestListener,
  archiveThread: (threadId): Effect.Effect<void, CodexRuntimeError> =>
    request(handle, 'thread/archive', { threadId }).pipe(Effect.asVoid),
  close: (): Promise<void> => handle.close(),
  health: request(handle, 'account/read', { refreshToken: false }, HEALTH_RPC_TIMEOUT_MS).pipe(
    Effect.asVoid,
  ),
  interruptTurn: (threadId, turnId): Effect.Effect<void, CodexRuntimeError> =>
    request(handle, 'turn/interrupt', { threadId, turnId }).pipe(Effect.asVoid),
  loadedThreads: request(handle, 'thread/loaded/list', {}).pipe(Effect.flatMap(parseLoadedThreads)),
  rateLimits: request(handle, 'account/rateLimits/read', undefined, STATUS_RPC_TIMEOUT_MS),
  respondToServerRequest: handle.respondToServerRequest,
  respondToServerRequestError: handle.respondToServerRequestError,
  startThread: request(handle, 'thread/start', threadStartParams(prompt, workingDirectory)).pipe(
    Effect.flatMap((response) => responseId('thread/start', response, 'thread')),
    Effect.map((id) => CodexThreadId.make(id)),
  ),
  startTurn: (options): Effect.Effect<CodexTurnId, CodexRuntimeError> =>
    request(handle, 'turn/start', {
      clientUserMessageId: options.clientUserMessageId,
      input: userInput(options.input, options.attachments),
      threadId: options.threadId,
    }).pipe(
      Effect.flatMap((response) => responseId('turn/start', response, 'turn')),
      Effect.map((id) => CodexTurnId.make(id)),
    ),
  steerTurn: (options): Effect.Effect<void, CodexRuntimeError> =>
    request(handle, 'turn/steer', {
      clientUserMessageId: options.clientUserMessageId,
      expectedTurnId: options.expectedTurnId,
      input: userInput(options.input, options.attachments),
      threadId: options.threadId,
    }).pipe(Effect.asVoid),
  usage: request(handle, 'account/usage/read'),
  waitForTurn: (threadId, turnId, handlers): Effect.Effect<ClassifiedOutput, CodexRuntimeError> =>
    waitForTurn(handle, threadId, turnId, handlers),
});

const openRuntime = Effect.fn('SpikeCodex.open')(function* openRuntime(
  paths: SpikePaths,
  config: SpikeConfig,
  accountId: string,
  logMode: CodexLogMode = 'quiet',
) {
  yield* Effect.tryPromise({
    catch: (cause) => runtimeError('home/create', cause),
    try: () => mkdir(config.codexHome, { recursive: true }),
  });
  const userContext = yield* Effect.tryPromise({
    catch: (cause) => runtimeError('prompt/read', cause),
    try: () => readFile(config.promptPath, 'utf8'),
  });
  const prompt = assembleSystemPrompt(userContext, {
    casing: config.casing,
    emoji: config.emoji,
    finalPunctuation: config.finalPunctuation,
    swearing: config.swearing,
    wit: config.wit,
  });
  const handle = yield* spawnAppServer(paths, config, logMode);
  yield* initializeRpc(handle).pipe(Effect.tapError(() => Effect.promise(() => handle.close())));
  return makeCodexRuntime(handle, prompt, accountId, config.workingDirectory);
});

const openAccountCodexRuntime = Effect.fn('SpikeCodex.openAccount')(
  function* openAccountCodexRuntime(
    paths: SpikePaths,
    config: SpikeConfig,
    accountOptions: AccountPoolOptions,
    account: AccountRecord,
    logMode: CodexLogMode = 'quiet',
  ) {
    yield* activateAccount(accountOptions, account);
    return yield* openRuntime(paths, config, account.id, logMode);
  },
);

const readCustomProvider = (config: SpikeConfig): Effect.Effect<null | string, CodexRuntimeError> =>
  Effect.tryPromise({
    catch: (cause) => runtimeError('provider/read', cause),
    try: () => customProvider(config.codexHome),
  });

const openProviderCodexRuntime = (
  paths: SpikePaths,
  config: SpikeConfig,
  provider: string,
  logMode: CodexLogMode = 'quiet',
): Effect.Effect<CodexRuntime, CodexRuntimeError> =>
  openRuntime(paths, config, `provider:${provider}`, logMode);

export { makeCodexRuntime, openAccountCodexRuntime, openProviderCodexRuntime, readCustomProvider };
export type { CodexRuntime, StartTurnOptions, SteerTurnOptions } from './runtime-types';
