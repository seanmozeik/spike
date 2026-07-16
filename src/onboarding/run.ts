import { rm } from 'node:fs/promises';

import type { SpikePaths } from '../paths';
import { authenticateCodex, discoverCodexModels } from './codex';
import { discoverDirectConversations, normalizePeerHandle } from './conversation';
import { assertVirginInstall, prepareInstallation, removeInstalledConfiguration } from './install';
import { openFullDiskAccessSettings, requestMessagesAutomation, runPreflight } from './preflight';
import type { OnboardingPrompts } from './prompts';
import { waitForRoundTrip } from './round-trip';
import type { CodexModelOption, ConversationCandidate, OnboardingPlan } from './types';

interface OnboardingServices {
  readonly authenticate: typeof authenticateCodex;
  readonly discoverConversations: typeof discoverDirectConversations;
  readonly discoverModels: (executable: string) => readonly CodexModelOption[];
  readonly doctor: () => Promise<{ readonly healthy: boolean }>;
  readonly openFullDiskAccess: () => void;
  readonly prepare: typeof prepareInstallation;
  readonly preflight: typeof runPreflight;
  readonly removeLaunchAgent: () => Promise<void>;
  readonly removeRoot: typeof removeInstalledConfiguration;
  readonly requestAutomation: () => void;
  readonly start: () => Promise<unknown>;
  readonly stop: () => Promise<unknown>;
  readonly waitForRoundTrip: typeof waitForRoundTrip;
}

interface RunOnboardingOptions {
  readonly paths: SpikePaths;
  readonly prompts: OnboardingPrompts;
  readonly services: OnboardingServices;
}

const discoverConversation = async (
  prompts: OnboardingPrompts,
  services: OnboardingServices,
  databasePath: string,
  bunExecutable: string,
): Promise<ConversationCandidate> => {
  const handle = normalizePeerHandle(await prompts.peerHandle());
  const attempt = async (): Promise<ConversationCandidate> => {
    let candidates: readonly ConversationCandidate[];
    try {
      candidates = services.discoverConversations(databasePath, handle);
    } catch (error) {
      services.openFullDiskAccess();
      const retry = await prompts.confirmRetryFullDiskAccess(
        bunExecutable,
        error instanceof Error ? error.message : String(error),
      );
      if (!retry) {
        throw error;
      }
      return attempt();
    }
    if (candidates.length === 0) {
      const message = `No direct iMessage conversation was found for ${handle}. Start one in Messages, then retry.`;
      if (await prompts.confirmRetryConversation(message)) {return attempt();}
      throw new Error(message);
    }
    return  prompts.chooseConversation(candidates);
  };
  return attempt();
};

const summarize = (plan: OnboardingPlan): string => {
  let codex = 'default Codex config';
  if (plan.codex.kind === 'openai') {
    codex = `${plan.codex.model} · ${plan.codex.reasoning}`;
  } else if (plan.codex.kind === 'custom') {
    codex = `custom config · ${plan.codex.configPath}`;
  }
  return [
    `Conversation  ${plan.conversation.handle}`,
    `Chat GUID     ${plan.conversation.chatGuid}`,
    `Workspace     ${plan.workingDirectory}`,
    `Codex         ${codex}`,
    `Permissions   ${plan.approvalPolicy} · ${plan.sandboxMode}`,
    `Likes         ${plan.personality.likeAcknowledgements ? 'on' : 'off'}`,
  ].join('\n');
};

const collectPlan = async (
  prompts: OnboardingPrompts,
  services: OnboardingServices,
): Promise<{ readonly codexExecutable: string; readonly plan: OnboardingPlan }> => {
  const preflight = await prompts.runTask('Checking this Mac', (log) => {
    const report = services.preflight();
    log(`Bun ${Bun.version}: ${report.bunExecutable}`);
    log(`Codex: ${report.codexExecutable}`);
    log(`Messages: ${report.messagesDatabase}`);
    return Promise.resolve(report);
  });
  const conversation = await discoverConversation(
    prompts,
    services,
    preflight.messagesDatabase,
    preflight.bunExecutable,
  );
  const workingDirectory = await prompts.workingDirectory();
  const personality = await prompts.personality();
  const models = await prompts.runTask('Loading the current Codex model catalog', () =>
    Promise.resolve(services.discoverModels(preflight.codexExecutable)),
  );
  const codex = await prompts.chooseCodex(models);
  const approvalPolicy = await prompts.approvalPolicy();
  const sandboxMode = await prompts.sandboxMode();
  const context = await prompts.context();
  return {
    codexExecutable: preflight.codexExecutable,
    plan: {
      approvalPolicy,
      codex,
      context,
      conversation,
      messagesDatabase: preflight.messagesDatabase,
      personality,
      sandboxMode,
      workingDirectory,
    },
  };
};

const reportRollbackFailure =
  (operation: string) =>
  (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Spike rollback failed during ${operation}: ${detail}\n`);
  };

const rollback = async (options: RunOnboardingOptions): Promise<void> => {
  await options.services.stop().catch(reportRollbackFailure('stop'));
  await options.services.removeLaunchAgent().catch(reportRollbackFailure('LaunchAgent cleanup'));
  await options.services.removeRoot(options.paths).catch(reportRollbackFailure('config cleanup'));
};

const runOnboarding = async (options: RunOnboardingOptions): Promise<void> => {
  assertVirginInstall(options.paths);
  options.prompts.intro();
  const { codexExecutable, plan } = await collectPlan(options.prompts, options.services);
  if (!(await options.prompts.confirmApply(summarize(plan)))) {
    options.prompts.finish('Nothing changed.');
    return;
  }
  const startedAt = new Date();
  const prepared = await options.prompts.runTask('Preparing Spike', (log) =>
    options.services.prepare({
      authenticate: options.services.authenticate,
      codexExecutable,
      log,
      paths: options.paths,
      plan,
    }),
  );
  let committed = false;
  try {
    await prepared.commit();
    committed = true;
    options.services.requestAutomation();
    await options.prompts.runTask('Starting Spike and running diagnostics', async (log) => {
      await options.services.start();
      log('LaunchAgent started');
      const report = await options.services.doctor();
      if (!report.healthy) {
        throw new Error('spike doctor reported a failed check');
      }
      log('spike doctor is healthy');
    });
    if (!(await options.prompts.waitForFirstMessage())) {
      throw new Error('first-message verification cancelled');
    }
    await options.prompts.runTask('Waiting for Spike’s first reply', () =>
      options.services.waitForRoundTrip(plan.messagesDatabase, plan.conversation, startedAt),
    );
  } catch (error) {
    await (committed ? rollback(options) : prepared.discard());
    throw error;
  }
  options.prompts.finish('Spike is installed, healthy, and replying in iMessage.');
};

const defaultServices = (
  start: () => Promise<unknown>,
  stop: () => Promise<unknown>,
  doctor: () => Promise<{ readonly healthy: boolean }>,
  paths: SpikePaths,
): OnboardingServices => ({
  authenticate: authenticateCodex,
  discoverConversations: discoverDirectConversations,
  discoverModels: discoverCodexModels,
  doctor,
  openFullDiskAccess: openFullDiskAccessSettings,
  preflight: runPreflight,
  prepare: prepareInstallation,
  removeLaunchAgent: (): Promise<void> => rm(paths.launchAgent, { force: true }),
  removeRoot: removeInstalledConfiguration,
  requestAutomation: requestMessagesAutomation,
  start,
  stop,
  waitForRoundTrip,
});

export { collectPlan, defaultServices, runOnboarding, summarize };
export type { OnboardingServices, RunOnboardingOptions };
