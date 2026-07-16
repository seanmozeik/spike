import { rm } from 'node:fs/promises';

import type { SpikePaths } from '../paths';
import { authenticateCodex, discoverCodexModels, validateCodexConfiguration } from './codex';
import { discoverDirectConversations } from './conversation';
import { prepareInstallation, removeInstalledConfiguration } from './install';
import {
  openAccessibilitySettings,
  openAutomationSettings,
  openFullDiskAccessSettings,
  requestAccessibility,
  requestMessagesAutomation,
  runPreflight,
} from './preflight';
import { waitForRoundTrip } from './round-trip';
import type { OnboardingServices } from './run';

const defaultServices = (
  start: () => Promise<unknown>,
  stop: () => Promise<unknown>,
  doctor: () => Promise<{ readonly healthy: boolean }>,
  paths: SpikePaths,
): OnboardingServices => ({
  authenticate: authenticateCodex,
  checkAccessibility: requestAccessibility,
  checkAutomation: requestMessagesAutomation,
  discoverConversations: discoverDirectConversations,
  discoverModels: discoverCodexModels,
  doctor,
  openAccessibility: openAccessibilitySettings,
  openAutomation: openAutomationSettings,
  openFullDiskAccess: openFullDiskAccessSettings,
  preflight: runPreflight,
  prepare: prepareInstallation,
  removeLaunchAgent: (): Promise<void> => rm(paths.launchAgent, { force: true }),
  removeRoot: removeInstalledConfiguration,
  start,
  stop,
  validateCodex: validateCodexConfiguration,
  waitForRoundTrip,
});

export { defaultServices };
