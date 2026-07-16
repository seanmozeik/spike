import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { loadSpikeConfig } from '../src/app-config';
import { prepareInstallation, removeInstalledConfiguration } from '../src/onboarding/install';
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
  confirmRetryConversation: (): Promise<boolean> => Promise.resolve(false),
  confirmRetryFullDiskAccess: (): Promise<boolean> => Promise.resolve(false),
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
  requestAutomation: (): void => {
    events.push('automation');
  },
  start: (): Promise<void> => {
    events.push('start');
    return Promise.resolve();
  },
  stop: (): Promise<void> => Promise.resolve(),
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
