import { expect, it } from 'vitest';

import { errorMessageChain, safeErrorDiagnostic, safeErrorTag } from '../src/error-message';
import { WaitingForCapacity } from '../src/errors';

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

it('does not promote opaque cause metadata into a nested diagnostic', () => {
  expect(errorMessageChain(new Error('turn failed', { cause: 'turn-1' }))).toBe('turn failed');
  expect(errorMessageChain(new Error('turn failed', { cause: { turnId: 'turn-1' } }))).toBe(
    'turn failed',
  );
});

it('retains the classification of message-less tagged causes', () => {
  const error = new Error('engine phase failed', {
    cause: new WaitingForCapacity({ resetAt: null }),
  });

  expect(errorMessageChain(error)).toBe('engine phase failed: WaitingForCapacity');
});

it('does not throw when nested cause prototype inspection is hostile', () => {
  const hostileCause = new Proxy(
    {},
    {
      getPrototypeOf: (): never => {
        throw new Error('prototype inspection denied');
      },
    },
  );
  const error = new Error('engine phase failed', { cause: hostileCause });

  expect(safeErrorDiagnostic(error)).toBe('engine phase failed');
});

it('strips terminal formatting, redacts secrets, and bounds error tags', () => {
  const tag = safeErrorTag({ _tag: `\u{1B}[31mBearer secret-token\n${'x'.repeat(100)}\u{1B}[0m` });

  expect(tag).toBe(`[redacted] ${'x'.repeat(69)}`);
  expect(tag).toHaveLength(80);
});

it('strips terminal formatting, redacts secrets, normalizes whitespace, and bounds diagnostics', () => {
  const error = new Error(
    `\u{1B}[31mBearer secret-token\nsk-abcdefghijk ghp_abcdefghijk ${'x'.repeat(400)}\u{1B}[0m`,
  );
  const diagnostic = safeErrorDiagnostic(error);

  expect(diagnostic).toBe(`[redacted] [redacted] [redacted] ${'x'.repeat(267)}`);
  expect(diagnostic).toHaveLength(300);
});

it('bounds traversed causes even when every wrapper repeats the same message', () => {
  let reads = 0;
  const current = repeatedErrorChain(20, () => {
    reads += 1;
  });

  expect(errorMessageChain(current)).toBe('provider unavailable');
  expect(reads).toBe(8);
});
