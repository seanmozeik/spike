import { existsSync } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';

import { Effect } from 'effect';

import { SpikeRuntimeError } from './errors';
import type { SpikePaths } from './paths';

const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

export const ensureRuntimeLayout = Effect.fn('SpikeConfig.ensureRuntimeLayout')(
  function* ensureRuntimeLayout(paths: SpikePaths) {
    yield* Effect.tryPromise({
      catch: (cause) =>
        new SpikeRuntimeError({
          cause,
          message: `failed to prepare ${paths.root}`,
          operation: 'ensure-runtime-layout',
        }),
      try: async () => {
        const directories = [
          paths.root,
          paths.codexHome,
          paths.accounts,
          paths.state,
          paths.attachments,
          paths.run,
          paths.logs,
        ];
        await Promise.all(
          directories.map((directory) =>
            mkdir(directory, { mode: OWNER_ONLY_DIRECTORY_MODE, recursive: true }),
          ),
        );
        await Promise.all(
          directories.map((directory) => chmod(directory, OWNER_ONLY_DIRECTORY_MODE)),
        );
        if (existsSync(paths.config)) {
          await chmod(paths.config, OWNER_ONLY_FILE_MODE);
        }
        const daemonLog = await open(paths.daemonLog, 'a', OWNER_ONLY_FILE_MODE);
        try {
          await daemonLog.chmod(OWNER_ONLY_FILE_MODE);
        } finally {
          await daemonLog.close();
        }
      },
    });
  },
);
