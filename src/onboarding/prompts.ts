import { statSync } from 'node:fs';

import * as clack from '@clack/prompts';
import { Schema } from 'effect';

import { chooseCodexPrompt } from './prompt-codex';
import { personalityPrompt } from './prompt-personality';
import { unwrap } from './prompt-shared';
import type {
  CodexModelOption,
  CodexSetup,
  ConversationCandidate,
  OnboardingPlan,
  PersonalityAnswers,
} from './types';

interface OnboardingPrompts {
  readonly approvalPolicy: () => Promise<'never'>;
  readonly chooseCodex: (models: readonly CodexModelOption[]) => Promise<CodexSetup>;
  readonly chooseConversation: (
    candidates: readonly ConversationCandidate[],
  ) => Promise<ConversationCandidate>;
  readonly confirmApply: (summary: string) => Promise<boolean>;
  readonly confirmRetryAuthentication: (error: string) => Promise<boolean>;
  readonly confirmRetryConversation: (message: string) => Promise<boolean>;
  readonly confirmRetryFullDiskAccess: (bunExecutable: string, error: string) => Promise<boolean>;
  readonly confirmRetryPermission: (permission: string, error: string) => Promise<boolean>;
  readonly context: () => Promise<string>;
  readonly finish: (message: string) => void;
  readonly intro: () => void;
  readonly peerHandle: () => Promise<string>;
  readonly personality: () => Promise<PersonalityAnswers>;
  readonly runTask: <A>(
    title: string,
    task: (log: (message: string) => void) => Promise<A>,
  ) => Promise<A>;
  readonly sandboxMode: () => Promise<OnboardingPlan['sandboxMode']>;
  readonly waitForFirstMessage: () => Promise<boolean>;
  readonly workingDirectory: () => Promise<string>;
}

const PeerHandle = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        /^\+[1-9]\d{7,14}$/u.test(value.replaceAll(/[\s().-]/gu, '')) ||
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim()),
      { title: 'E.164 phone number or iMessage email' },
    ),
  ),
);
const ExistingDirectory = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        try {
          return statSync(value).isDirectory();
        } catch {
          return false;
        }
      },
      { title: 'existing directory' },
    ),
  ),
);

const approvalPolicyPrompt = async (): Promise<'never'> => {
  const answer = unwrap(
    await clack.select({
      initialValue: 'never' as const,
      message: 'When may Spike run tools?',
      options: [
        { hint: 'recommended for headless use', label: 'Without asking', value: 'never' as const },
        {
          disabled: true,
          hint: 'coming in MTA-317',
          label: 'Ask when needed',
          value: 'on-request' as const,
        },
      ],
    }),
  );
  if (answer !== 'never') {
    throw new Error('permission prompting is not available yet');
  }
  return answer;
};

const chooseConversationPrompt = async (
  candidates: readonly ConversationCandidate[],
): Promise<ConversationCandidate> => {
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) {
    return only;
  }
  return unwrap(
    await clack.autocomplete({
      message: 'Choose the exact direct conversation',
      options: candidates.map((candidate) => ({
        hint: candidate.lastMessageAt?.toLocaleString() ?? 'no messages yet',
        label: candidate.handle,
        value: candidate,
      })),
    }),
  );
};

const confirmApplyPrompt = async (summary: string): Promise<boolean> => {
  clack.box(summary, 'Spike will install', { width: 76 });
  return unwrap(await clack.confirm({ initialValue: true, message: 'Apply this configuration?' }));
};

const confirmRetryPrompt = async (bunExecutable: string, error: string): Promise<boolean> => {
  clack.log.warn(`${error}\nGrant Full Disk Access to:\n${bunExecutable}`);
  return unwrap(await clack.confirm({ message: 'Retry after approving Full Disk Access?' }));
};

const confirmRetryConversationPrompt = async (message: string): Promise<boolean> => {
  clack.log.warn(message);
  return unwrap(await clack.confirm({ message: 'Retry conversation discovery?' }));
};

const confirmRetryAuthenticationPrompt = async (error: string): Promise<boolean> => {
  clack.log.warn(error);
  return unwrap(await clack.confirm({ message: 'Retry isolated Codex authentication?' }));
};

const confirmRetryPermissionPrompt = async (
  permission: string,
  error: string,
): Promise<boolean> => {
  clack.log.warn(error);
  return unwrap(await clack.confirm({ message: `Retry after approving ${permission}?` }));
};

const contextPrompt = async (): Promise<string> =>
  unwrap(
    await clack.multiline({
      message: 'Add personal context for Spike (optional)',
      placeholder: 'What should Spike know about you, your work, and your preferences?',
      showSubmit: true,
    }),
  );

const peerHandlePrompt = async (): Promise<string> =>
  unwrap(
    await clack.text({
      message: 'Who should Spike talk to?',
      placeholder: '+447700900123 or spike@icloud.com',
      validate: Schema.toStandardSchemaV1(PeerHandle),
    }),
  );

const runTaskPrompt = async <A>(
  title: string,
  task: (log: (message: string) => void) => Promise<A>,
): Promise<A> => {
  const logger = clack.taskLog({ retainLog: true, title });
  try {
    const value = await task((message) => {
      logger.message(message);
    });
    logger.success(`${title} complete`);
    return value;
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error), { showLog: true });
    throw error;
  }
};

const sandboxPrompt = async (): Promise<OnboardingPlan['sandboxMode']> =>
  unwrap(
    await clack.select({
      initialValue: 'danger-full-access' as const,
      message: 'How much filesystem access should Spike have?',
      options: [
        { hint: 'recommended', label: 'Full access', value: 'danger-full-access' as const },
        { label: 'Workspace write', value: 'workspace-write' as const },
        { label: 'Read only', value: 'read-only' as const },
      ],
    }),
  );

const waitForFirstMessagePrompt = async (): Promise<boolean> =>
  unwrap(
    await clack.confirm({
      initialValue: true,
      message: 'Send Spike a message in the configured conversation, then continue',
    }),
  );

const workingDirectoryPrompt = async (): Promise<string> =>
  unwrap(
    await clack.path({
      directory: true,
      initialValue: process.cwd(),
      message: 'Where should Spike work by default?',
      root: process.cwd(),
      validate: Schema.toStandardSchemaV1(ExistingDirectory),
    }),
  );

const realPrompts = (): OnboardingPrompts => ({
  approvalPolicy: approvalPolicyPrompt,
  chooseCodex: chooseCodexPrompt,
  chooseConversation: chooseConversationPrompt,
  confirmApply: confirmApplyPrompt,
  confirmRetryAuthentication: confirmRetryAuthenticationPrompt,
  confirmRetryConversation: confirmRetryConversationPrompt,
  confirmRetryFullDiskAccess: confirmRetryPrompt,
  confirmRetryPermission: confirmRetryPermissionPrompt,
  context: contextPrompt,
  finish: (message: string): void => {
    clack.outro(message);
  },
  intro: (): void => {
    clack.intro('Spike onboarding');
  },
  peerHandle: peerHandlePrompt,
  personality: personalityPrompt,
  runTask: runTaskPrompt,
  sandboxMode: sandboxPrompt,
  waitForFirstMessage: waitForFirstMessagePrompt,
  workingDirectory: workingDirectoryPrompt,
});

export { realPrompts };
export type { OnboardingPrompts };
