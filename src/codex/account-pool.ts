import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

import { Effect } from 'effect';

import { WaitingForAuthentication, WaitingForCapacity } from '../errors';

type AccountAuthState = 'Invalid' | 'Valid';

interface AccountRecord {
  readonly authPath: string;
  readonly authState: AccountAuthState;
  readonly id: string;
  readonly lastSelectedAt: null | Date;
  readonly resetAt: null | Date;
}

type AccountSelection =
  | { readonly account: AccountRecord; readonly kind: 'Selected' }
  | { readonly error: WaitingForAuthentication; readonly kind: 'WaitingForAuthentication' }
  | { readonly error: WaitingForCapacity; readonly kind: 'WaitingForCapacity' };

interface AccountPoolOptions {
  readonly accountsDirectory: string;
  readonly codexHome: string;
  readonly seedAuthPath: string;
}

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

const selectAccount = (accounts: readonly AccountRecord[], now: Date): AccountSelection => {
  const valid = accounts.filter((account) => account.authState === 'Valid');
  if (valid.length === 0) {
    return {
      error: new WaitingForAuthentication({ message: 'no valid Codex account is configured' }),
      kind: 'WaitingForAuthentication',
    };
  }
  const eligible = valid.filter((account) => account.resetAt === null || account.resetAt <= now);
  if (eligible.length === 0) {
    const sortedResets = valid
      .map((account) => account.resetAt)
      .filter((value): value is Date => value !== null)
      .toSorted((left, right) => left.getTime() - right.getTime());
    const [resetAt = null] = sortedResets;
    return { error: new WaitingForCapacity({ resetAt }), kind: 'WaitingForCapacity' };
  }
  const [account] = eligible.toSorted(
    (left, right) => (left.lastSelectedAt?.getTime() ?? 0) - (right.lastSelectedAt?.getTime() ?? 0),
  );
  if (account === undefined) {
    return {
      error: new WaitingForAuthentication({ message: 'account selection was empty' }),
      kind: 'WaitingForAuthentication',
    };
  }
  return { account, kind: 'Selected' };
};

const seedDefaultAccount = async (options: AccountPoolOptions): Promise<void> => {
  const entries = await readdir(options.accountsDirectory, { withFileTypes: true });
  if (entries.some((entry) => entry.isDirectory()) || !(await pathExists(options.seedAuthPath))) {
    return;
  }
  const directory = path.join(options.accountsDirectory, 'default');
  await mkdir(directory, { recursive: true });
  await copyFile(options.seedAuthPath, path.join(directory, 'auth.json'));
};

const discoverAccounts = Effect.fn('SpikeAccounts.discover')((options: AccountPoolOptions) =>
  Effect.tryPromise({
    catch: () =>
      new WaitingForAuthentication({ message: 'failed to discover standalone Codex accounts' }),
    try: async () => {
      await mkdir(options.accountsDirectory, { recursive: true });
      await seedDefaultAccount(options);
      const entries = await readdir(options.accountsDirectory, { withFileTypes: true });
      const candidates = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry): Promise<AccountRecord | null> => {
            const authPath = path.join(options.accountsDirectory, entry.name, 'auth.json');
            return (await pathExists(authPath))
              ? {
                  authPath,
                  authState: 'Valid' as const,
                  id: entry.name,
                  lastSelectedAt: null,
                  resetAt: null,
                }
              : null;
          }),
      );
      return candidates.filter((account): account is AccountRecord => account !== null);
    },
  }),
);

const activateAccount = Effect.fn('SpikeAccounts.activate')(
  (options: AccountPoolOptions, account: AccountRecord) =>
    Effect.tryPromise({
      catch: () =>
        new WaitingForAuthentication({ message: `failed to activate Codex account ${account.id}` }),
      try: async () => {
        await mkdir(options.codexHome, { recursive: true });
        const destination = path.join(options.codexHome, 'auth.json');
        const temporary = `${destination}.${randomUUID()}.tmp`;
        await copyFile(account.authPath, temporary);
        await rename(temporary, destination);
      },
    }),
);

export { activateAccount, discoverAccounts, selectAccount };
export type { AccountPoolOptions, AccountRecord, AccountSelection };
