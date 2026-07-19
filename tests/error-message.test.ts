import { expect, it } from 'vitest';

import { errorMessageChain } from '../src/error-message';

const repeatedErrorChain = (
  remaining: number,
  onCauseRead: () => void,
  cause?: Error,
): Error | undefined => {
  if (remaining === 0) {
    return cause;
  }
  const error = new Error('provider unavailable');
  Object.defineProperty(error, 'cause', {
    get: () => {
      onCauseRead();
      return cause;
    },
  });
  return repeatedErrorChain(remaining - 1, onCauseRead, error);
};

it('renders nested boundary failures from outer context to actionable cause', () => {
  const error = new Error('failed to start supervised Codex runtime', {
    cause: new Error('no valid Codex account is configured'),
  });

  expect(errorMessageChain(error)).toBe(
    'failed to start supervised Codex runtime: no valid Codex account is configured',
  );
});

it('renders message-bearing RPC error objects', () => {
  const error = new Error('failed to initialize Codex app-server', {
    cause: { code: -32_000, message: 'fixture provider unavailable' },
  });

  expect(errorMessageChain(error)).toBe(
    'failed to initialize Codex app-server: fixture provider unavailable',
  );
});

it('deduplicates repeated wrapper messages and stops cyclic causes', () => {
  const inner = new Error('provider unavailable');
  const outer = new Error('failed to initialize provider', { cause: inner });
  Object.defineProperty(inner, 'cause', { value: outer });

  expect(errorMessageChain(outer)).toBe('failed to initialize provider: provider unavailable');
});

it('formats non-error defects without throwing', () => {
  expect(errorMessageChain({ reason: 'fixture' })).toBe('[object Object]');
});

it('bounds traversed causes even when every wrapper repeats the same message', () => {
  let reads = 0;
  const current = repeatedErrorChain(20, () => {
    reads += 1;
  });

  expect(errorMessageChain(current)).toBe('provider unavailable');
  expect(reads).toBe(8);
});
