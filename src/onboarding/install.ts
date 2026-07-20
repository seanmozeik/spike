import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Effect } from 'effect';

import { loadSpikeConfig } from '../app-config';
import { ensureRuntimeLayout } from '../config-files';
import { spikePaths, type SpikePaths } from '../paths';
import { DEFAULT_USER_CONTEXT } from '../system-prompt';
import {
  type authenticateCodex,
  renderCodexConfig,
  seedDefaultAccount,
  type validateCodexConfiguration,
} from './codex';
import type { OnboardingPlan } from './types';

interface InstallOptions {
  readonly authenticate: typeof authenticateCodex;
  readonly codexExecutable: string;
  readonly log: (message: string) => void;
  readonly paths: SpikePaths;
  readonly plan: OnboardingPlan;
  readonly validateCodex: typeof validateCodexConfiguration;
}

interface PreparedInstallation {
  readonly commit: () => Promise<void>;
  readonly discard: () => Promise<void>;
}

const PRIVATE_FILE_MODE = 0o600;

const toml = (value: string): string => JSON.stringify(value);

const renderAppConfig = (
  plan: OnboardingPlan,
  paths: SpikePaths,
  codexExecutable: string,
): string =>
  [
    `chat_guid = ${toml(plan.conversation.chatGuid)}`,
    `handle = ${toml(plan.conversation.handle)}`,
    `working_directory = ${toml(plan.workingDirectory)}`,
    `prompt_path = ${toml(paths.prompt)}`,
    `codex_home = ${toml(paths.codexHome)}`,
    `codex_executable = ${toml(codexExecutable)}`,
    `casing = ${toml(plan.personality.casing)}`,
    `emoji = ${toml(plan.personality.emoji)}`,
    `final_punctuation = ${toml(plan.personality.finalPunctuation)}`,
    `swearing = ${toml(plan.personality.swearing)}`,
    `wit = ${toml(plan.personality.wit)}`,
    `messages_database = ${toml(plan.messagesDatabase)}`,
    `like_acknowledgements = ${String(plan.personality.likeAcknowledgements)}`,
    `preferred_name = ${toml(plan.preferredName)}`,
    `timezone = ${toml(plan.timezone)}`,
    '',
  ].join('\n');

const assertVirginInstall = (paths: SpikePaths): void => {
  if (existsSync(paths.config)) {
    throw new Error(
      'Spike is already configured. Use spike config, spike doctor, or spike repair.',
    );
  }
  if (existsSync(paths.root)) {
    throw new Error(`Spike’s install directory already exists: ${paths.root}`);
  }
};

const installSignalCleanup = (stageRoot: string): (() => void) => {
  const cleanup = (): void => {
    rmSync(stageRoot, { force: true, recursive: true });
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  return () => {
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
  };
};

const prepareInstallation = async (options: InstallOptions): Promise<PreparedInstallation> => {
  assertVirginInstall(options.paths);
  const stageRoot = path.join(
    path.dirname(options.paths.root),
    `.${path.basename(options.paths.root)}-init-${randomUUID()}`,
  );
  const stage = spikePaths(stageRoot);
  const releaseSignalCleanup = installSignalCleanup(stageRoot);
  try {
    await Effect.runPromise(ensureRuntimeLayout(stage));
    const codexConfig = await renderCodexConfig(
      options.plan.codex,
      options.plan.approvalPolicy,
      options.plan.sandboxMode,
    );
    const prompt = options.plan.context.trim() || DEFAULT_USER_CONTEXT;
    await Promise.all([
      writeFile(
        stage.config,
        renderAppConfig(options.plan, options.paths, options.codexExecutable),
        'utf8',
      ),
      writeFile(stage.codexConfig, codexConfig, 'utf8'),
      writeFile(stage.prompt, `${prompt.trim()}\n`, 'utf8'),
    ]);
    await chmod(stage.config, PRIVATE_FILE_MODE);
    options.validateCodex(options.codexExecutable, stage.codexHome);
    if (options.plan.codex.kind !== 'custom') {
      await options.authenticate(options.codexExecutable, stage.codexHome, options.log);
      await seedDefaultAccount(stage.codexHome, stage.accounts);
    }
    await Effect.runPromise(loadSpikeConfig(stage));
    Bun.TOML.parse(await readFile(stage.codexConfig, 'utf8'));
  } catch (error) {
    await rm(stageRoot, { force: true, recursive: true });
    throw error;
  } finally {
    releaseSignalCleanup();
  }
  return {
    commit: async () => {
      await mkdir(path.dirname(options.paths.root), { recursive: true });
      await rename(stageRoot, options.paths.root);
    },
    discard: () => rm(stageRoot, { force: true, recursive: true }),
  };
};

const removeInstalledConfiguration = (paths: SpikePaths): Promise<void> =>
  rm(paths.root, { force: true, recursive: true });

export { assertVirginInstall, prepareInstallation, removeInstalledConfiguration, renderAppConfig };
export type { InstallOptions, PreparedInstallation };
