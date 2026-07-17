import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { loadSpikeConfig } from '../src/app-config';
import { ConversationDiscoveryError } from '../src/onboarding/conversation';
import { prepareInstallation, removeInstalledConfiguration } from '../src/onboarding/install';
import { runOnboardingPreview } from '../src/onboarding/preview';
import type { OnboardingPrompts } from '../src/onboarding/prompts';
import { runOnboarding, type OnboardingServices } from '../src/onboarding/run';
import type { ConversationCandidate, PersonalityAnswers } from '../src/onboarding/types';
import { spikePaths, type SpikePaths } from '../src/paths';

const roots: string[] = [];
const conversation: ConversationCandidate = {
  chatGuid: 'iMessage;-;spike@icloud.com',
  handle: 'spike@icloud.com',
  lastMessageAt: new Date('2026-07-17T10:00:00Z'),
};
const personality: PersonalityAnswers = {
  casing: 'natural',
  emoji: 'off',
  finalPunctuation: 'natural',
  likeAcknowledgements: false,
  swearing: 'mirror',
  wit: 'playful',
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const fakePrompts = (events: string[]): OnboardingPrompts => ({
  approvalPolicy: (): Promise<'never'> => Promise.resolve('never'),
  chooseCodex: (): ReturnType<OnboardingPrompts['chooseCodex']> =>
    Promise.resolve({
      kind: 'openai',
      model: 'gpt-test',
      personality: 'pragmatic',
      reasoning: 'high',
      serviceTier: 'fast',
    }),
  chooseConversation: ([candidate]): ReturnType<OnboardingPrompts['chooseConversation']> =>
    candidate === undefined
      ? Promise.reject(new Error('missing candidate'))
      : Promise.resolve(candidate),
  confirmApply: (): Promise<boolean> => Promise.resolve(true),
  confirmRetryAuthentication: (): Promise<boolean> => Promise.resolve(false),
  confirmRetryConversation: (): Promise<boolean> => Promise.resolve(false),
  confirmRetryFullDiskAccess: (): Promise<boolean> => Promise.resolve(false),
  confirmRetryPermission: (): Promise<boolean> => Promise.resolve(false),
  context: (): Promise<string> => Promise.resolve('Sean builds trusted power tools.'),
  finish: (message: string): void => {
    events.push(`finish:${message}`);
  },
  intro: (): void => {
    events.push('intro');
  },
  peerHandle: (): Promise<string> => Promise.resolve('Spike@iCloud.com'),
  personality: (): Promise<PersonalityAnswers> => Promise.resolve(personality),
  runTask: <A>(_title: string, task: (log: (message: string) => void) => Promise<A>): Promise<A> =>
    task((message) => {
      events.push(`log:${message}`);
    }),
  sandboxMode: (): ReturnType<OnboardingPrompts['sandboxMode']> =>
    Promise.resolve('workspace-write'),
  waitForFirstMessage: (): Promise<boolean> => Promise.resolve(true),
  workingDirectory: (): Promise<string> => Promise.resolve('/tmp'),
});

const fakeAuthenticate: OnboardingServices['authenticate'] = async (
  _executable,
  codexHome,
): Promise<void> => {
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, 'auth.json'), '{"token":"isolated"}\n', 'utf8');
};

const fakeServices = (events: string[]): OnboardingServices => ({
  authenticate: fakeAuthenticate,
  checkAccessibility: (): void => {
    events.push('accessibility');
  },
  checkAutomation: (): void => {
    events.push('automation');
  },
  discoverConversations: (): readonly ConversationCandidate[] => [conversation],
  discoverModels: (): ReturnType<OnboardingServices['discoverModels']> => [
    {
      defaultReasoning: 'high',
      description: 'test model',
      displayName: 'GPT Test',
      reasoning: [{ description: 'deep', effort: 'high' }],
      serviceTiers: [{ description: 'fast', id: 'fast', name: 'Fast' }],
      slug: 'gpt-test',
    },
  ],
  doctor: (): Promise<{ readonly healthy: boolean }> => {
    events.push('doctor');
    return Promise.resolve({ healthy: true });
  },
  openAccessibility: (): void => {
    events.push('open-accessibility');
  },
  openAutomation: (): void => {
    events.push('open-automation');
  },
  openFullDiskAccess: (): void => {
    events.push('fda');
  },
  preflight: (): ReturnType<OnboardingServices['preflight']> => ({
    bunExecutable: '/opt/homebrew/bin/bun',
    codexExecutable: '/opt/homebrew/bin/codex',
    messagesDatabase: '/tmp/chat.db',
  }),
  prepare: prepareInstallation,
  removeLaunchAgent: (): Promise<void> => Promise.resolve(),
  removeRoot: removeInstalledConfiguration,
  start: (): Promise<void> => {
    events.push('start');
    return Promise.resolve();
  },
  stop: (): Promise<void> => Promise.resolve(),
  validateCodex: (): void => {
    events.push('codex-valid');
  },
  waitForRoundTrip: (): Promise<void> => {
    events.push('round-trip');
    return Promise.resolve();
  },
});

const makeTarget = (): SpikePaths => {
  const parent = mkdtempSync(path.join(tmpdir(), 'spike-onboarding-'));
  roots.push(parent);
  return spikePaths(path.join(parent, 'spike'));
};

it('installs and verifies a complete isolated onboarding flow', async () => {
  const paths = makeTarget();
  const events: string[] = [];
  await runOnboarding({ paths, prompts: fakePrompts(events), services: fakeServices(events) });

  const config = await Effect.runPromise(loadSpikeConfig(paths));
  expect(config).toMatchObject({
    casing: 'natural',
    chatGuid: conversation.chatGuid,
    codexHome: paths.codexHome,
    handle: conversation.handle,
    likeAcknowledgements: false,
    workingDirectory: '/tmp',
  });
  expect(readFileSync(paths.codexConfig, 'utf8')).toContain('model = "gpt-test"');
  expect(readFileSync(paths.codexConfig, 'utf8')).toContain('sandbox_mode = "workspace-write"');
  expect(readFileSync(paths.prompt, 'utf8')).toContain('trusted power tools');
  expect(readFileSync(path.join(paths.accounts, 'default', 'auth.json'), 'utf8')).toContain(
    'isolated',
  );
  expect(events).toContain('start');
  expect(events).toContain('doctor');
  expect(events).toContain('round-trip');
  expect(events).toContain('codex-valid');
  expect(events.at(-1)).toContain('installed, healthy, and replying');
});

it('rolls back the virgin install when post-launch verification fails', async () => {
  const paths = makeTarget();
  const events: string[] = [];
  const services = fakeServices(events);
  await expect(
    runOnboarding({
      paths,
      prompts: fakePrompts(events),
      services: { ...services, doctor: () => Promise.resolve({ healthy: false }) },
    }),
  ).rejects.toThrow('spike doctor');
  expect(existsSync(paths.root)).toBe(false);
});

it('writes nothing when the review is declined', async () => {
  const paths = makeTarget();
  const events: string[] = [];
  await runOnboarding({
    paths,
    prompts: {
      ...fakePrompts(events),
      confirmApply: (): Promise<boolean> => Promise.resolve(false),
    },
    services: fakeServices(events),
  });
  expect(existsSync(paths.root)).toBe(false);
  expect(events.at(-1)).toBe('finish:Nothing changed.');
});

it('previews every configuration prompt without exposing live-system services', async () => {
  const paths = makeTarget();
  const events: string[] = [];
  const prompts = fakePrompts(events);
  let reviewed = '';
  await runOnboardingPreview({
    ...prompts,
    approvalPolicy: () => {
      events.push('approval');
      return Promise.resolve('never');
    },
    chooseCodex: (models) => {
      events.push(`models:${models.length}`);
      return prompts.chooseCodex(models);
    },
    confirmApply: (summary) => {
      reviewed = summary;
      events.push('review');
      return Promise.resolve(true);
    },
    context: () => {
      events.push('context');
      return prompts.context();
    },
    peerHandle: () => {
      events.push('peer');
      return prompts.peerHandle();
    },
    personality: () => {
      events.push('personality');
      return prompts.personality();
    },
    sandboxMode: () => {
      events.push('sandbox');
      return prompts.sandboxMode();
    },
    workingDirectory: () => {
      events.push('workspace');
      return prompts.workingDirectory();
    },
  });

  expect(existsSync(paths.root)).toBe(false);
  expect(events).toEqual([
    'intro',
    'peer',
    'workspace',
    'personality',
    'models:2',
    'approval',
    'sandbox',
    'context',
    'review',
    'finish:Preview complete. Nothing was changed.',
  ]);
  expect(reviewed).toContain('spike@icloud.com');
  expect(reviewed).toContain('gpt-test · high');
});

it('retries the real conversation query after Full Disk Access is approved', async () => {
  const paths = makeTarget();
  const events: string[] = [];
  let discoveries = 0;
  const services = fakeServices(events);
  await runOnboarding({
    paths,
    prompts: {
      ...fakePrompts(events),
      confirmRetryFullDiskAccess: (): Promise<boolean> => Promise.resolve(true),
    },
    services: {
      ...services,
      discoverConversations: (): readonly ConversationCandidate[] => {
        discoveries += 1;
        if (discoveries === 1) {
          throw new ConversationDiscoveryError('permission', 'operation not permitted');
        }
        return [conversation];
      },
    },
  });
  expect(discoveries).toBe(2);
  expect(events).toContain('fda');
});

it('retries Automation and Accessibility before writing configuration', async () => {
  const paths = makeTarget();
  const events: string[] = [];
  let automationAttempts = 0;
  let accessibilityAttempts = 0;
  let authenticationAttempts = 0;
  const services = fakeServices(events);
  const prompts = fakePrompts(events);
  await runOnboarding({
    paths,
    prompts: {
      ...prompts,
      confirmRetryAuthentication: (): Promise<boolean> => Promise.resolve(true),
      confirmRetryPermission: (): Promise<boolean> => Promise.resolve(true),
      personality: (): Promise<PersonalityAnswers> =>
        Promise.resolve({ ...personality, likeAcknowledgements: true }),
    },
    services: {
      ...services,
      authenticate: async (executable, codexHome, log): Promise<void> => {
        authenticationAttempts += 1;
        if (authenticationAttempts === 1) {
          throw new Error('device login interrupted');
        }
        await fakeAuthenticate(executable, codexHome, log);
      },
      checkAccessibility: (): void => {
        accessibilityAttempts += 1;
        if (accessibilityAttempts === 1) {
          throw new Error('Accessibility denied');
        }
      },
      checkAutomation: (): void => {
        automationAttempts += 1;
        if (automationAttempts === 1) {
          throw new Error('Automation denied');
        }
      },
    },
  });
  expect(automationAttempts).toBe(2);
  expect(accessibilityAttempts).toBe(2);
  expect(authenticationAttempts).toBe(2);
  expect(events).toContain('open-automation');
  expect(events).toContain('open-accessibility');
});
