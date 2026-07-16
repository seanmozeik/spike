import { expect, it } from 'vitest';

import { classifyCodexAvailability } from '../src/codex/availability';
import { CodexRuntimeError, WaitingForAuthentication, WaitingForCapacity } from '../src/errors';

const runtimeError = (message: string): CodexRuntimeError =>
  new CodexRuntimeError({
    cause: new Error(message),
    message: 'turn failed',
    operation: 'turn/start',
  });

it('maps authentication rejection to the explicit authentication wait state', () => {
  expect(classifyCodexAvailability(runtimeError('401 unauthorized'))).toBeInstanceOf(
    WaitingForAuthentication,
  );
});

it('maps account exhaustion to the explicit capacity wait state', () => {
  expect(classifyCodexAvailability(runtimeError('429 rate limit exceeded'))).toBeInstanceOf(
    WaitingForCapacity,
  );
});

it('preserves failures whose submission outcome may be unknown', () => {
  expect(classifyCodexAvailability(runtimeError('connection reset'))).toBeInstanceOf(
    CodexRuntimeError,
  );
});
