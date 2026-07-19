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
const account = (id: string, overrides: Partial<AccountRecord> = {}): AccountRecord => ({
  authPath: `/accounts/${id}/auth.json`,
  authState: 'Valid',
  id,
  lastSelectedAt: null,
  mode: null,
  observedAt: null,
  resetAt: null,
  ...overrides,
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it('enters explicit authentication or capacity waits without fictional rotation', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  expect(selectAccount([], now).kind).toBe('WaitingForAuthentication');
  expect(selectAccount([{ ...account('invalid'), authState: 'Invalid' }], now).kind).toBe(
    'WaitingForAuthentication',
  );
  const exhausted = selectAccount(
    [
      account('only', {
        mode: 'Capacity',
        observedAt: now,
        resetAt: new Date('2026-07-14T17:00:00Z'),
      }),
    ],
    now,
  );
  expect(exhausted.kind).toBe('WaitingForCapacity');
  const selected = selectAccount(
    [account('recent', { lastSelectedAt: new Date('2026-07-14T11:00:00Z') }), account('oldest')],
    now,
  );
  expect(selected.kind).toBe('Selected');
  if (selected.kind === 'Selected') {
    expect(selected.account.id).toBe('oldest');
  }
});

it('selects the next LRU eligible account when the active account is exhausted', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const selected = selectAccount(
    [
      account('active', {
        lastSelectedAt: new Date('2026-07-14T11:00:00Z'),
        mode: 'Capacity',
        observedAt: now,
        resetAt: new Date('2026-07-14T17:00:00Z'),
      }),
      account('backup', { lastSelectedAt: new Date('2026-07-14T10:00:00Z') }),
    ],
    now,
  );
  expect(selected.kind).toBe('Selected');
  if (selected.kind === 'Selected') {
    expect(selected.account.id).toBe('backup');
  }
});

it('waits for the earliest retry when all accounts are exhausted', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const selected = selectAccount(
    [
      account('later', {
        mode: 'Capacity',
        observedAt: now,
        resetAt: new Date('2026-07-14T18:00:00Z'),
      }),
      account('earlier', {
        mode: 'Capacity',
        observedAt: now,
        resetAt: new Date('2026-07-14T16:00:00Z'),
      }),
    ],
    now,
  );
  expect(selected.kind).toBe('WaitingForCapacity');
  if (selected.kind === 'WaitingForCapacity') {
    expect(selected.error.resetAt).toEqual(new Date('2026-07-14T16:00:00Z'));
  }
});

it('retries a stale capacity observation and breaks equal LRU ties by account id', () => {
  const now = new Date('2026-07-14T12:30:00Z');
  const selected = selectAccount(
    [
      account('zeta', { mode: 'Capacity', observedAt: new Date('2026-07-14T12:00:00Z') }),
      account('alpha', { mode: 'Capacity', observedAt: new Date('2026-07-14T12:00:00Z') }),
    ],
    now,
  );
  expect(selected.kind).toBe('Selected');
  if (selected.kind === 'Selected') {
    expect(selected.account.id).toBe('alpha');
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
