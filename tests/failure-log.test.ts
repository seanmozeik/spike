import { describe, expect, it } from 'vitest';

import { safeErrorDiagnostic } from '../src/error-message';
import { JournalTransactionError } from '../src/errors';
import { makeFailureLog } from '../src/logging/failure-log';

describe('application failure log', () => {
  it('emits the first failure and rate-limits identical retry noise', () => {
    const lines: string[] = [];
    const log = makeFailureLog({
      repeatIntervalMs: 60_000,
      write: (line) => {
        lines.push(line);
      },
    });
    const diagnostic = {
      errorTag: 'MessagesQueryError',
      message: '\u{1B}[31mscripted inbox scan failure\u{1B}[0m',
      operation: 'engine',
    } as const;

    log.report({ ...diagnostic, at: new Date('2026-07-20T10:00:00.000Z') });
    log.report({ ...diagnostic, at: new Date('2026-07-20T10:00:01.000Z') });
    log.report({ ...diagnostic, at: new Date('2026-07-20T10:00:02.000Z') });
    log.report({ ...diagnostic, at: new Date('2026-07-20T10:01:00.000Z') });

    expect(lines).toStrictEqual([
      '2026-07-20T10:00:00.000Z [error] engine MessagesQueryError: scripted inbox scan failure',
      '2026-07-20T10:01:00.000Z [error] engine MessagesQueryError: scripted inbox scan failure suppressed_repeats=2',
    ]);
  });

  it('does not suppress a distinct application failure', () => {
    const lines: string[] = [];
    const log = makeFailureLog({
      write: (line) => {
        lines.push(line);
      },
    });
    const at = new Date('2026-07-20T10:00:00.000Z');

    log.report({ at, errorTag: 'FirstError', message: 'first failure', operation: 'engine' });
    log.report({ at, errorTag: 'SecondError', message: 'second failure', operation: 'engine' });

    expect(lines).toHaveLength(2);
  });

  it('keeps a nested journal cause actionable without leaking terminal codes or secrets', () => {
    const lines: string[] = [];
    const log = makeFailureLog({
      write: (line) => {
        lines.push(line);
      },
    });
    const error = new JournalTransactionError({
      cause: new Error(
        '\u{1B}[31mgeneration rotation requires settled durable work\nBearer secret-token\u{1B}[0m',
      ),
      message: 'scheduler journal transaction failed: loadOrCreate',
      transaction: 'loadOrCreate',
    });

    log.report({
      at: new Date('2026-07-20T10:00:00.000Z'),
      errorTag: 'JournalTransactionError',
      message: safeErrorDiagnostic(error),
      operation: 'engine',
    });

    expect(lines).toStrictEqual([
      '2026-07-20T10:00:00.000Z [error] engine JournalTransactionError: scheduler journal transaction failed: loadOrCreate: generation rotation requires settled durable work [redacted]',
    ]);
  });
});
