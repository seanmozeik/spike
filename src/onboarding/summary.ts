import type { OnboardingPlan } from './types';

const summarizeOnboardingPlan = (plan: OnboardingPlan): string => {
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
    `Name          ${plan.preferredName}`,
    `Timezone      ${plan.timezone}`,
    `Codex         ${codex}`,
    `Permissions   ${plan.approvalPolicy} · ${plan.sandboxMode}`,
    `Likes         ${plan.personality.likeAcknowledgements ? 'on' : 'off'}`,
  ].join('\n');
};

export { summarizeOnboardingPlan };
