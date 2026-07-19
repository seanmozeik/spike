import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

import { Duration, Effect } from 'effect';

import { WaitingForAuthentication, WaitingForCapacity } from '../errors';
import {
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  listStoredAccounts,
} from './account-store';

type AccountAuthState = 'Invalid' | 'Valid';
type AccountAvailabilityMode = 'Authentication' | 'Available' | 'Capacity';
const DEFAULT_OBSERVATION_STALE_MS = Duration.toMillis('15 minutes');

interface AccountRecord {
  readonly authPath: string;
  readonly authState: AccountAuthState;
  readonly id: string;
  readonly lastSelectedAt: null | Date;
  readonly mode: AccountAvailabilityMode | null;
  readonly observedAt: null | Date;
  readonly resetAt: null | Date;
}

interface AccountObservation {
  readonly accountId: string;
  readonly lastSelectedAt: Date | null;
  readonly mode: AccountAvailabilityMode;
  readonly observedAt: Date;
  readonly resetAt: Date | null;
}

type AccountSelection =
  | { readonly account: AccountRecord; readonly kind: 'Selected' }
  | { readonly error: WaitingForAuthentication; readonly kind: 'WaitingForAuthentication' }
  | { readonly error: WaitingForCapacity; readonly kind: 'WaitingForCapacity' };

interface AccountPoolOptions {
  readonly accountsDirectory: string;
  readonly codexHome: string;
  readonly observationStaleMs?: number;
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

const retryAt = (account: AccountRecord, staleAfterMs: number): Date | null => {
  if (account.mode !== 'Capacity') {
    return null;
  }
  if (account.resetAt !== null) {
    return account.resetAt;
  }
  return account.observedAt === null ? null : new Date(account.observedAt.getTime() + staleAfterMs);
};

const compareAccountSelection = (left: AccountRecord, right: AccountRecord): number => {
  const leftSelected = left.lastSelectedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightSelected = right.lastSelectedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (leftSelected === rightSelected) {
    return left.id.localeCompare(right.id);
  }
  return leftSelected - rightSelected;
};

const selectAccount = (
  accounts: readonly AccountRecord[],
  now: Date,
  observationStaleMs = DEFAULT_OBSERVATION_STALE_MS,
): AccountSelection => {
  const valid = accounts.filter((account) => account.authState === 'Valid');
  if (valid.length === 0) {
    return {
      error: new WaitingForAuthentication({ message: 'no valid Codex account is configured' }),
      kind: 'WaitingForAuthentication',
    };
  }
  const eligible = valid.filter((account) => {
    if (account.mode === 'Authentication') {
      return false;
    }
    const nextRetry = retryAt(account, observationStaleMs);
    return nextRetry === null || nextRetry <= now;
  });
  if (eligible.length === 0) {
    const sortedResets = valid
      .map((account) => retryAt(account, observationStaleMs))
      .filter((value): value is Date => value !== null)
      .toSorted((left, right) => left.getTime() - right.getTime());
    const [resetAt] = sortedResets;
    if (resetAt !== undefined) {
      return { error: new WaitingForCapacity({ resetAt }), kind: 'WaitingForCapacity' };
    }
    return {
      error: new WaitingForAuthentication({ message: 'all Codex accounts require authentication' }),
      kind: 'WaitingForAuthentication',
    };
  }
  const [account] = eligible.toSorted((left, right) => compareAccountSelection(left, right));
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
  await mkdir(directory, { mode: OWNER_ONLY_DIRECTORY_MODE, recursive: true });
  await chmod(directory, OWNER_ONLY_DIRECTORY_MODE);
  const authPath = path.join(directory, 'auth.json');
  await copyFile(options.seedAuthPath, authPath);
  await chmod(authPath, OWNER_ONLY_FILE_MODE);
};

const discoverAccounts = Effect.fn('SpikeAccounts.discover')(
  (options: AccountPoolOptions, observations: readonly AccountObservation[] = []) =>
    Effect.gen(function* discoverStoredAccounts() {
      yield* Effect.tryPromise({
        catch: () =>
          new WaitingForAuthentication({ message: 'failed to seed the default Codex account' }),
        try: async () => {
          await mkdir(options.accountsDirectory, {
            mode: OWNER_ONLY_DIRECTORY_MODE,
            recursive: true,
          });
          await chmod(options.accountsDirectory, OWNER_ONLY_DIRECTORY_MODE);
          await seedDefaultAccount(options);
        },
      });
      const snapshots = new Map(
        observations.map((observation) => [observation.accountId, observation]),
      );
      return (yield* listStoredAccounts(options)).map((stored): AccountRecord => {
        const observation = snapshots.get(stored.id);
        return {
          authPath: stored.authPath,
          authState: 'Valid' as const,
          id: stored.id,
          lastSelectedAt: observation?.lastSelectedAt ?? null,
          mode: observation?.mode ?? null,
          observedAt: observation?.observedAt ?? null,
          resetAt: observation?.resetAt ?? null,
        };
      });
    }),
);

const activateAccount = Effect.fn('SpikeAccounts.activate')(
  (options: AccountPoolOptions, account: AccountRecord) =>
    Effect.tryPromise({
      catch: () =>
        new WaitingForAuthentication({ message: `failed to activate Codex account ${account.id}` }),
      try: async () => {
        await mkdir(options.codexHome, { mode: OWNER_ONLY_DIRECTORY_MODE, recursive: true });
        await chmod(options.codexHome, OWNER_ONLY_DIRECTORY_MODE);
        const destination = path.join(options.codexHome, 'auth.json');
        const temporary = `${destination}.${randomUUID()}.tmp`;
        await copyFile(account.authPath, temporary);
        await chmod(temporary, OWNER_ONLY_FILE_MODE);
        await rename(temporary, destination);
        await chmod(destination, OWNER_ONLY_FILE_MODE);
      },
    }),
);

export { activateAccount, discoverAccounts, selectAccount };
export type {
  AccountAvailabilityMode,
  AccountObservation,
  AccountPoolOptions,
  AccountRecord,
  AccountSelection,
};
