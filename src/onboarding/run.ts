import type { SpikePaths } from '../paths';
import { systemTimezone } from '../timezone';
import type { authenticateCodex, validateCodexConfiguration } from './codex';
import {
  ConversationDiscoveryError,
  type discoverDirectConversations,
  normalizePeerHandle,
} from './conversation';
import {
  assertVirginInstall,
  type prepareInstallation,
  type PreparedInstallation,
  type removeInstalledConfiguration,
} from './install';
import type { runPreflight } from './preflight';
import type { OnboardingPrompts } from './prompts';
import type { waitForRoundTrip } from './round-trip';
import { summarizeOnboardingPlan } from './summary';
import type { CodexModelOption, ConversationCandidate, OnboardingPlan } from './types';

interface OnboardingServices {
  readonly authenticate: typeof authenticateCodex;
  readonly checkAccessibility: () => void;
  readonly checkAutomation: () => void;
  readonly discoverConversations: typeof discoverDirectConversations;
  readonly discoverModels: (executable: string) => readonly CodexModelOption[];
  readonly doctor: () => Promise<{ readonly healthy: boolean }>;
  readonly openAccessibility: () => void;
  readonly openAutomation: () => void;
  readonly openFullDiskAccess: () => void;
  readonly prepare: typeof prepareInstallation;
  readonly preflight: typeof runPreflight;
  readonly removeLaunchAgent: () => Promise<void>;
  readonly removeRoot: typeof removeInstalledConfiguration;
  readonly start: () => Promise<unknown>;
  readonly stop: () => Promise<unknown>;
  readonly waitForRoundTrip: typeof waitForRoundTrip;
  readonly validateCodex: typeof validateCodexConfiguration;
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
      if (!(error instanceof ConversationDiscoveryError) || error.kind !== 'permission') {
        throw error;
      }
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
      if (await prompts.confirmRetryConversation(message)) {
        return attempt();
      }
      throw new Error(message);
    }
    return prompts.chooseConversation(candidates);
  };
  return attempt();
};

const ensurePermission = async (
  prompts: OnboardingPrompts,
  name: string,
  check: () => void,
  openSettings: () => void,
): Promise<void> => {
  try {
    check();
  } catch (error) {
    openSettings();
    const retry = await prompts.confirmRetryPermission(
      name,
      error instanceof Error ? error.message : String(error),
    );
    if (!retry) {
      throw error;
    }
    await ensurePermission(prompts, name, check, openSettings);
  }
};

const authenticateWithRetry = async (
  prompts: OnboardingPrompts,
  authenticate: typeof authenticateCodex,
  executable: string,
  codexHome: string,
  log: (message: string) => void,
): Promise<void> => {
  try {
    await authenticate(executable, codexHome, log);
  } catch (error) {
    const retry = await prompts.confirmRetryAuthentication(
      error instanceof Error ? error.message : String(error),
    );
    if (!retry) {
      throw error;
    }
    await authenticateWithRetry(prompts, authenticate, executable, codexHome, log);
  }
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
  const preferredNameAnswer = await prompts.preferredName();
  const preferredName = preferredNameAnswer.trim();
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
      preferredName,
      sandboxMode,
      timezone: systemTimezone(),
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

const ensureRequiredPermissions = async (
  options: RunOnboardingOptions,
  plan: OnboardingPlan,
): Promise<void> => {
  await ensurePermission(
    options.prompts,
    'Messages Automation',
    options.services.checkAutomation,
    options.services.openAutomation,
  );
  if (plan.personality.likeAcknowledgements) {
    await ensurePermission(
      options.prompts,
      'Accessibility',
      options.services.checkAccessibility,
      options.services.openAccessibility,
    );
  }
};

const prepareOnboarding = (
  options: RunOnboardingOptions,
  codexExecutable: string,
  plan: OnboardingPlan,
): Promise<PreparedInstallation> =>
  options.prompts.runTask('Preparing Spike', (log) =>
    options.services.prepare({
      authenticate: (executable, codexHome, output) =>
        authenticateWithRetry(
          options.prompts,
          options.services.authenticate,
          executable,
          codexHome,
          output,
        ),
      codexExecutable,
      log,
      paths: options.paths,
      plan,
      validateCodex: options.services.validateCodex,
    }),
  );

const runOnboarding = async (options: RunOnboardingOptions): Promise<void> => {
  assertVirginInstall(options.paths);
  options.prompts.intro();
  const { codexExecutable, plan } = await collectPlan(options.prompts, options.services);
  if (!(await options.prompts.confirmApply(summarizeOnboardingPlan(plan)))) {
    options.prompts.finish('Nothing changed.');
    return;
  }
  await ensureRequiredPermissions(options, plan);
  const startedAt = new Date();
  const prepared = await prepareOnboarding(options, codexExecutable, plan);
  let committed = false;
  try {
    await prepared.commit();
    committed = true;
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

export { collectPlan, runOnboarding };
export type { OnboardingServices, RunOnboardingOptions };
