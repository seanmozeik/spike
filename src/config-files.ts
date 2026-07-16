import { mkdir, writeFile } from 'node:fs/promises';

import { Effect } from 'effect';

import { SpikeRuntimeError } from './errors';
import type { SpikePaths } from './paths';
import { DEFAULT_USER_CONTEXT } from './system-prompt';

const APP_CONFIG = `chat_guid = "any;-;+15555550123"
handle = "+15555550123"
working_directory = "~/Documents"
prompt_path = "~/.config/spike/prompt.md"
codex_home = "~/.config/spike/codex-home"
codex_executable = "codex"
casing = "lowercase"
emoji = "after_user"
final_punctuation = "no_full_stop"
swearing = "tasteful"
wit = "dry"
seed_auth_path = "~/.codex/auth.json"
messages_database = "~/Library/Messages/chat.db"
like_acknowledgements = true
`;

const CODEX_CONFIG = `# Spike uses this isolated Codex home without modifying your main Codex profile.
# Configure model, provider, reasoning, service tier, approvals, sandbox, MCPs,
# hooks, skills, and feature flags here using the normal Codex configuration format.
`;

const writeIfMissing = async (filePath: string, content: string): Promise<void> => {
  try {
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'EEXIST') {
      return;
    }
    throw error;
  }
};

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
        await Promise.all([
          writeIfMissing(paths.config, APP_CONFIG),
          writeIfMissing(paths.codexConfig, CODEX_CONFIG),
          writeIfMissing(paths.prompt, `${DEFAULT_USER_CONTEXT}\n`),
        ]);
      },
    });
  },
);
