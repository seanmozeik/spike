import { mkdir } from 'node:fs/promises';

import { Effect } from 'effect';

import { SpikeRuntimeError } from './errors';
import type { SpikePaths } from './paths';

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
        await Promise.all([
          mkdir(paths.root, { recursive: true }),
          mkdir(paths.codexHome, { recursive: true }),
          mkdir(paths.accounts, { recursive: true }),
          mkdir(paths.state, { recursive: true }),
          mkdir(paths.run, { recursive: true }),
          mkdir(paths.logs, { recursive: true }),
        ]);
      },
    });
  },
);
