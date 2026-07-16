import { Effect } from 'effect';

import { GenerationBroken, type CodexRuntimeError } from '../errors';

const JSON_RPC_INVALID_REQUEST = -32_600;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isMissingRollout = (error: CodexRuntimeError): boolean =>
  isObject(error.cause) &&
  error.cause['code'] === JSON_RPC_INVALID_REQUEST &&
  typeof error.cause['message'] === 'string' &&
  error.cause['message'].startsWith('no rollout found for thread id ');

const isThreadNotLoaded = (error: CodexRuntimeError): boolean =>
  isObject(error.cause) &&
  error.cause['code'] === JSON_RPC_INVALID_REQUEST &&
  typeof error.cause['message'] === 'string' &&
  error.cause['message'].startsWith('thread not loaded: ');

const classifyThreadError = (error: CodexRuntimeError): CodexRuntimeError | GenerationBroken =>
  isMissingRollout(error)
    ? new GenerationBroken({ message: 'Codex thread is missing; send /new' })
    : error;

const classifyThreadLookup = <A>(
  effect: Effect.Effect<A, CodexRuntimeError>,
): Effect.Effect<A, CodexRuntimeError | GenerationBroken> =>
  effect.pipe(Effect.mapError(classifyThreadError));

export { classifyThreadLookup, isThreadNotLoaded };
