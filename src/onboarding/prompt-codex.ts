import * as clack from '@clack/prompts';

import { unwrap } from './prompt-shared';
import type { CodexModelOption, CodexSetup } from './types';

const chooseServiceTier = async (model: CodexModelOption): Promise<null | string> =>
  unwrap(
    await clack.select({
      initialValue: null,
      message: 'Choose a service tier',
      options: [
        { label: 'Standard', value: null },
        ...model.serviceTiers.map((tier) => ({
          hint: tier.description,
          label: tier.name,
          value: tier.id,
        })),
      ],
    }),
  );

const chooseOpenAiModel = async (models: readonly CodexModelOption[]): Promise<CodexSetup> => {
  const model = unwrap(
    await clack.autocomplete({
      maxItems: 8,
      message: 'Choose a Codex model',
      options: models.map((entry) => ({
        hint: entry.description,
        label: entry.displayName,
        value: entry.slug,
      })),
    }),
  );
  const selected = models.find(({ slug }) => slug === model);
  if (selected === undefined) {
    throw new Error(`Codex model disappeared: ${model}`);
  }
  const reasoning = unwrap(
    await clack.select({
      initialValue: selected.defaultReasoning,
      message: 'How much reasoning should Spike use?',
      options: selected.reasoning.map((entry) => ({
        hint: entry.description,
        label: entry.effort,
        value: entry.effort,
      })),
    }),
  );
  const personality = unwrap(
    await clack.select({
      initialValue: 'pragmatic' as const,
      message: 'Choose Codex’s built-in personality',
      options: [
        { label: 'Pragmatic', value: 'pragmatic' as const },
        { label: 'Friendly', value: 'friendly' as const },
        { label: 'None', value: 'none' as const },
      ],
    }),
  );
  const serviceTier = await chooseServiceTier(selected);
  return { kind: 'openai', model, personality, reasoning, serviceTier };
};

const chooseCodexPrompt = async (models: readonly CodexModelOption[]): Promise<CodexSetup> => {
  const kind = unwrap(
    await clack.select({
      message: 'How should Spike configure Codex?',
      options: [
        {
          hint: 'guided setup and device login',
          label: 'OpenAI account',
          value: 'openai' as const,
        },
        {
          hint: 'use a Codex config file',
          label: 'Custom or local model',
          value: 'custom' as const,
        },
        {
          hint: 'use Codex defaults and authenticate',
          label: 'Skip advanced setup',
          value: 'skip' as const,
        },
      ],
    }),
  );
  if (kind === 'custom') {
    const configPath = unwrap(
      await clack.path({ message: 'Select the Codex config to use', root: process.cwd() }),
    );
    return { configPath, kind };
  }
  return kind === 'skip' ? { kind } : chooseOpenAiModel(models);
};

export { chooseCodexPrompt };
