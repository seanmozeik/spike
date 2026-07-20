import { systemTimezone } from '../timezone';
import { normalizePeerHandle } from './conversation';
import type { OnboardingPrompts } from './prompts';
import { summarizeOnboardingPlan } from './summary';
import type { CodexModelOption, OnboardingPlan } from './types';

const PREVIEW_MODELS: readonly CodexModelOption[] = [
  {
    defaultReasoning: 'medium',
    description: 'Static hosted-model fixture; Codex is not contacted',
    displayName: 'GPT Preview',
    reasoning: [
      { description: 'Faster replies', effort: 'low' },
      { description: 'Balanced for everyday use', effort: 'medium' },
      { description: 'More time for difficult tasks', effort: 'high' },
    ],
    serviceTiers: [{ description: 'Static preview option', id: 'fast', name: 'Fast' }],
    slug: 'gpt-preview',
  },
  {
    defaultReasoning: 'high',
    description: 'Second static fixture for the model picker',
    displayName: 'GPT Preview Pro',
    reasoning: [
      { description: 'Balanced for everyday use', effort: 'medium' },
      { description: 'More time for difficult tasks', effort: 'high' },
    ],
    serviceTiers: [],
    slug: 'gpt-preview-pro',
  },
];

const collectPreviewPlan = async (prompts: OnboardingPrompts): Promise<OnboardingPlan> => {
  const handle = normalizePeerHandle(await prompts.peerHandle());
  const conversation = await prompts.chooseConversation([
    { chatGuid: `iMessage;-;${handle}`, handle, lastMessageAt: new Date('2026-01-01T12:00:00Z') },
  ]);
  const workingDirectory = await prompts.workingDirectory();
  const personality = await prompts.personality();
  const codex = await prompts.chooseCodex(PREVIEW_MODELS);
  const approvalPolicy = await prompts.approvalPolicy();
  const sandboxMode = await prompts.sandboxMode();
  const preferredNameAnswer = await prompts.preferredName();
  const preferredName = preferredNameAnswer.trim();
  const context = await prompts.context();
  return {
    approvalPolicy,
    codex,
    context,
    conversation,
    messagesDatabase: '<preview: no Messages database opened>',
    personality,
    preferredName,
    sandboxMode,
    timezone: systemTimezone(),
    workingDirectory,
  };
};

const runOnboardingPreview = async (prompts: OnboardingPrompts): Promise<void> => {
  prompts.intro();
  const plan = await collectPreviewPlan(prompts);
  await prompts.confirmApply(summarizeOnboardingPlan(plan));
  prompts.finish('Preview complete. Nothing was changed.');
};

export { runOnboardingPreview };
