import { mkdir, readFile } from 'node:fs/promises';

import { Effect, Result } from 'effect';

import type { SpikeConfig } from '../app-config';
import { CodexThreadId, CodexTurnId } from '../domain/ids';
import { CodexRuntimeError } from '../errors';
import type { SpikePaths } from '../paths';
import { assembleSystemPrompt } from '../system-prompt';
import { activateAccount, discoverAccounts, selectAccount } from './account-pool';
import type { ClassifiedOutput } from './output-classifier';
import type { ThreadItem, ThreadSnapshot, ThreadTurn } from './reconcile';
import { initializeRpc, spawnRpcHandle, type RpcHandle } from './rpc';
import type { CodexRuntime } from './runtime-types';
import { classifyThreadLookup, isThreadNotLoaded } from './thread-errors';
import { waitForTurn } from './turn-wait';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const HEALTH_RPC_TIMEOUT_MS = 700;
const STATUS_RPC_TIMEOUT_MS = 2000;

const runtimeError = (operation: string, cause: unknown): CodexRuntimeError =>
  new CodexRuntimeError({ cause, message: `Codex ${operation} failed`, operation });

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
  cwd: workingDirectory,
  historyMode: 'legacy',
});

const textInput = (text: string): readonly Record<string, unknown>[] => [
  { text, text_elements: [], type: 'text' },
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
  startThread: request(handle, 'thread/start', threadStartParams(prompt, workingDirectory)).pipe(
    Effect.flatMap((response) => responseId('thread/start', response, 'thread')),
    Effect.map((id) => CodexThreadId.make(id)),
  ),
  startTurn: (options): Effect.Effect<CodexTurnId, CodexRuntimeError> =>
    request(handle, 'turn/start', {
      clientUserMessageId: options.clientUserMessageId,
      input: textInput(options.input),
      threadId: options.threadId,
    }).pipe(
      Effect.flatMap((response) => responseId('turn/start', response, 'turn')),
      Effect.map((id) => CodexTurnId.make(id)),
    ),
  steerTurn: (options): Effect.Effect<void, CodexRuntimeError> =>
    request(handle, 'turn/steer', {
      clientUserMessageId: options.clientUserMessageId,
      expectedTurnId: options.expectedTurnId,
      input: textInput(options.input),
      threadId: options.threadId,
    }).pipe(Effect.asVoid),
  usage: request(handle, 'account/usage/read'),
  waitForTurn: (threadId, turnId, handlers): Effect.Effect<ClassifiedOutput, CodexRuntimeError> =>
    waitForTurn(handle, threadId, turnId, handlers),
});

const openCodexRuntime = Effect.fn('SpikeCodex.open')(function* openCodexRuntime(
  paths: SpikePaths,
  config: SpikeConfig,
) {
  yield* Effect.tryPromise({
    catch: (cause) => runtimeError('home/create', cause),
    try: () => mkdir(config.codexHome, { recursive: true }),
  });
  const accountOptions = {
    accountsDirectory: paths.accounts,
    codexHome: config.codexHome,
    seedAuthPath: config.seedAuthPath,
  };
  const accounts = yield* discoverAccounts(accountOptions);
  const selection = selectAccount(accounts, new Date());
  if (selection.kind !== 'Selected') {
    return yield* selection.error;
  }
  yield* activateAccount(accountOptions, selection.account);
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
  const handle = spawnRpcHandle({
    codexExecutable: config.codexExecutable,
    codexHome: config.codexHome,
    stderrLog: paths.daemonLog,
  });
  yield* initializeRpc(handle).pipe(Effect.tapError(() => Effect.promise(() => handle.close())));
  return makeCodexRuntime(handle, prompt, selection.account.id, config.workingDirectory);
});

const restartCodexRuntime = Effect.fn('SpikeCodex.restart')(function* restartCodexRuntime(
  current: CodexRuntime,
  replacement: Effect.Effect<CodexRuntime, CodexRuntimeError>,
  threadId: CodexThreadId,
) {
  yield* Effect.tryPromise({
    catch: (cause) => runtimeError('restart/close', cause),
    try: () => current.close(),
  });
  const next = yield* replacement;
  yield* next
    .resumeThread(threadId)
    .pipe(Effect.tapError(() => Effect.promise(() => next.close())));
  return next;
});

export { makeCodexRuntime, openCodexRuntime, restartCodexRuntime };
export type { CodexRuntime, StartTurnOptions, SteerTurnOptions } from './runtime-types';
