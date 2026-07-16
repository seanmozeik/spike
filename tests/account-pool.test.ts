import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';
import { afterEach, expect, it } from 'vitest';

import {
  activateAccount,
  discoverAccounts,
  selectAccount,
  type AccountRecord,
} from '../src/codex/account-pool';

const roots: string[] = [];
const account = (id: string, resetAt: Date | null, lastSelectedAt: Date | null): AccountRecord => ({
  authPath: `/accounts/${id}/auth.json`,
  authState: 'Valid',
  id,
  lastSelectedAt,
  resetAt,
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it('enters explicit authentication or capacity waits without fictional rotation', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  expect(selectAccount([], now).kind).toBe('WaitingForAuthentication');
  expect(
    selectAccount([{ ...account('invalid', null, null), authState: 'Invalid' }], now).kind,
  ).toBe('WaitingForAuthentication');
  const exhausted = selectAccount([account('only', new Date('2026-07-14T17:00:00Z'), null)], now);
  expect(exhausted.kind).toBe('WaitingForCapacity');
  const selected = selectAccount(
    [account('recent', null, new Date('2026-07-14T11:00:00Z')), account('oldest', null, null)],
    now,
  );
  expect(selected.kind).toBe('Selected');
  if (selected.kind === 'Selected') {
    expect(selected.account.id).toBe('oldest');
  }
});

it('seeds and activates an isolated standalone auth snapshot', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-accounts-'));
  roots.push(root);
  const seedAuthPath = path.join(root, 'seed-auth.json');
  const options = {
    accountsDirectory: path.join(root, 'accounts'),
    codexHome: path.join(root, 'codex-home'),
    seedAuthPath,
  };
  await mkdir(root, { recursive: true });
  await writeFile(seedAuthPath, '{"token":"test"}', 'utf8');
  const accounts = await Effect.runPromise(discoverAccounts(options));
  expect(accounts.map(({ id }) => id)).toEqual(['default']);
  const selected = selectAccount(accounts, new Date());
  if (selected.kind !== 'Selected') {
    throw new Error('expected a selected account');
  }
  await Effect.runPromise(activateAccount(options, selected.account));
  expect(await readFile(path.join(options.codexHome, 'auth.json'), 'utf8')).toBe(
    '{"token":"test"}',
  );
});
