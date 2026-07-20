import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { Effect } from 'effect';

import { AccountStoreError } from '../errors';

const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

interface StoredAccount {
  readonly authPath: string;
  readonly id: string;
}

interface AccountStoreOptions {
  readonly accountsDirectory: string;
}

const storeError = (operation: string, message: string, cause: unknown): AccountStoreError =>
  new AccountStoreError({ cause, message, operation });

const assertAccountId = (id: string): void => {
  if (!ACCOUNT_ID_PATTERN.test(id)) {
    throw new Error(
      'account id must be 1-64 lowercase letters, numbers, dots, underscores, or hyphens',
    );
  }
};

const assertCredential = (contents: string): void => {
  const decoded: unknown = JSON.parse(contents);
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('Codex credential must be a JSON object');
  }
};

const ensureAccountsDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { mode: OWNER_ONLY_DIRECTORY_MODE, recursive: true });
  await chmod(directory, OWNER_ONLY_DIRECTORY_MODE);
};

const listStoredAccounts = Effect.fn('SpikeAccounts.listStored')(
  (options: AccountStoreOptions): Effect.Effect<readonly StoredAccount[], AccountStoreError> =>
    Effect.tryPromise({
      catch: (cause) =>
        storeError('list', 'failed to list isolated Codex account credentials', cause),
      try: async () => {
        await ensureAccountsDirectory(options.accountsDirectory);
        const entries = await readdir(options.accountsDirectory, { withFileTypes: true });
        const accounts = await Promise.all(
          entries
            .filter((entry) => entry.isDirectory() && ACCOUNT_ID_PATTERN.test(entry.name))
            .map(async (entry): Promise<StoredAccount | null> => {
              const directory = path.join(options.accountsDirectory, entry.name);
              const authPath = path.join(options.accountsDirectory, entry.name, 'auth.json');
              try {
                const metadata = await lstat(authPath);
                if (!metadata.isFile()) {
                  return null;
                }
                await chmod(directory, OWNER_ONLY_DIRECTORY_MODE);
                await chmod(authPath, OWNER_ONLY_FILE_MODE);
                return { authPath, id: entry.name };
              } catch {
                return null;
              }
            }),
        );
        return accounts
          .filter((account): account is StoredAccount => account !== null)
          .toSorted((left, right) => left.id.localeCompare(right.id));
      },
    }),
);

const addStoredAccount = Effect.fn('SpikeAccounts.addStored')(
  (
    options: AccountStoreOptions,
    id: string,
    sourcePath: string,
  ): Effect.Effect<StoredAccount, AccountStoreError> =>
    Effect.tryPromise({
      catch: (cause) =>
        storeError('add', `failed to add isolated Codex account ${JSON.stringify(id)}`, cause),
      try: async () => {
        assertAccountId(id);
        const contents = await readFile(sourcePath, 'utf8');
        assertCredential(contents);
        await ensureAccountsDirectory(options.accountsDirectory);

        const destination = path.join(options.accountsDirectory, id);
        try {
          await stat(destination);
          throw new Error(`Codex account ${id} already exists`);
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
            throw error;
          }
        }

        const temporary = path.join(options.accountsDirectory, `.${id}.${randomUUID()}.temporary`);
        try {
          await mkdir(temporary, { mode: OWNER_ONLY_DIRECTORY_MODE });
          const authPath = path.join(temporary, 'auth.json');
          await writeFile(authPath, contents, { flag: 'wx', mode: OWNER_ONLY_FILE_MODE });
          await chmod(authPath, OWNER_ONLY_FILE_MODE);
          await rename(temporary, destination);
          await chmod(destination, OWNER_ONLY_DIRECTORY_MODE);
          return { authPath: path.join(destination, 'auth.json'), id };
        } catch (error) {
          await rm(temporary, { force: true, recursive: true });
          throw error;
        }
      },
    }),
);

export {
  ACCOUNT_ID_PATTERN,
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  addStoredAccount,
  listStoredAccounts,
};
export type { AccountStoreOptions, StoredAccount };
