import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { openJournal } from '../src/database';
import { makeFailureLog } from '../src/logging/failure-log';
import { report } from '../src/service/context';

interface FailureRow {
  readonly error_tag: string;
  readonly message: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('reports hostile and revoked errors to both safe sinks', () =>
  Effect.gen(function* hostileReportBoundary() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-report-boundary-'));
    roots.push(root);
    const handle = yield* openJournal(path.join(root, 'spike.db'));
    const lines: string[] = [];
    const at = new Date('2026-07-20T10:00:00.000Z');
    const context = {
      failureLog: makeFailureLog({
        write: (line) => {
          lines.push(line);
        },
      }),
      now: (): Date => at,
      options: { database: handle.database },
    };
    const hostile = new Proxy(
      { message: `Bearer secret-token\n${'x'.repeat(400)}` },
      {
        get: (target, property, receiver): unknown => {
          if (property === '_tag' || property === 'cause' || property === 'name') {
            throw new Error('property access denied');
          }
          return Reflect.get(target, property, receiver);
        },
        getPrototypeOf: (): never => {
          throw new Error('prototype inspection denied');
        },
      },
    );
    const revocable = Proxy.revocable({ message: 'unreachable' }, {});
    revocable.revoke();

    try {
      expect(() => {
        report(context, hostile);
      }).not.toThrow();
      expect(() => {
        report(context, revocable.proxy);
      }).not.toThrow();

      const safeMessage = `[redacted] ${'x'.repeat(289)}`;
      expect(
        handle.database
          .query<FailureRow, []>(
            'SELECT error_tag, message FROM failures ORDER BY created_at, rowid',
          )
          .all(),
      ).toStrictEqual([
        { error_tag: 'UnknownError', message: safeMessage },
        { error_tag: 'UnknownError', message: 'unknown error' },
      ]);
      expect(lines).toStrictEqual([
        `${at.toISOString()} [error] engine UnknownError: ${safeMessage}`,
        `${at.toISOString()} [error] engine UnknownError: unknown error`,
      ]);
    } finally {
      handle.close();
    }
  }),
);
