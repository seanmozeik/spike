import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { afterEach, expect } from 'vitest';

import { addStoredAccount, listStoredAccounts } from '../src/codex/account-store';

const roots: string[] = [];
const MODE_MODULUS = 0o1000;

const permissionMode = (target: string): number => statSync(target).mode % MODE_MODULUS;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect(
  'stores credentials in owner-only directories without returning credential contents',
  () =>
    Effect.gen(function* ownerOnlyCredentialFixture() {
      const root = mkdtempSync(path.join(tmpdir(), 'spike-account-store-'));
      roots.push(root);
      const source = path.join(root, 'source.json');
      const accountsDirectory = path.join(root, 'accounts');
      writeFileSync(source, '{"token":"top-secret"}', { mode: 0o644 });

      const stored = yield* addStoredAccount({ accountsDirectory }, 'primary', source);
      expect(permissionMode(accountsDirectory)).toBe(0o700);
      expect(permissionMode(path.join(accountsDirectory, 'primary'))).toBe(0o700);
      expect(permissionMode(stored.authPath)).toBe(0o600);
      const listed = yield* listStoredAccounts({ accountsDirectory });
      expect(JSON.stringify(listed.map(({ id }) => ({ id })))).not.toContain('top-secret');
    }),
);

it.effect('rejects invalid ids and malformed credential files without creating snapshots', () =>
  Effect.gen(function* invalidCredentialFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-account-store-invalid-'));
    roots.push(root);
    const source = path.join(root, 'source.json');
    const accountsDirectory = path.join(root, 'accounts');
    writeFileSync(source, 'not-json', 'utf8');

    const malformed = yield* Effect.result(
      addStoredAccount({ accountsDirectory }, 'primary', source),
    );
    expect(Result.isFailure(malformed)).toBe(true);
    expect(yield* listStoredAccounts({ accountsDirectory })).toEqual([]);

    writeFileSync(source, '{}', 'utf8');
    const invalidId = yield* Effect.result(
      addStoredAccount({ accountsDirectory }, '../escape', source),
    );
    expect(Result.isFailure(invalidId)).toBe(true);
    expect(yield* listStoredAccounts({ accountsDirectory })).toEqual([]);
  }),
);
