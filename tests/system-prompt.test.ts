import { describe, expect, it } from 'vitest';

import { assembleSystemPrompt, DEFAULT_USER_CONTEXT } from '../src/system-prompt';

const personality = {
  casing: 'lowercase',
  emoji: 'after_user',
  finalPunctuation: 'no_full_stop',
  swearing: 'tasteful',
  wit: 'dry',
} as const;

describe('Spike system prompt', () => {
  it('keeps the product voice in the immutable system layer', () => {
    const prompt = assembleSystemPrompt('', personality);
    expect(prompt).toContain('Text in lowercase, always');
    expect(prompt).toContain('Match the user');
    expect(prompt).toContain('Do not swear by default');
    expect(prompt).toContain('Do not use em dashes');
    expect(prompt).toContain('Do not end a reply with a full stop');
    expect(prompt).toContain('how can I help');
    expect(prompt).not.toMatch(/\bS(?:ean)\b/u);
    expect(prompt).not.toContain('/Users/');
  });

  it('appends user context after the system layer', () => {
    const context = 'The user is Example. Work from /workspace and use the example MCP.';
    const assembled = assembleSystemPrompt(context, personality);
    expect(assembled.startsWith('You are Spike')).toBe(true);
    expect(assembled).toContain(`User context\n\n${context}`);
    expect(assembled.indexOf(context)).toBeGreaterThan(
      assembled.indexOf('When in doubt, say less'),
    );
  });

  it('does not add an empty context section', () => {
    expect(assembleSystemPrompt(' \n ', personality)).not.toContain('User context');
    expect(DEFAULT_USER_CONTEXT).not.toMatch(/\bS(?:ean)\b/u);
  });

  it.each([
    ['off', 'Do not use emoji.'],
    ['on', 'Emoji are allowed when they fit naturally.'],
    ['after_user', 'Use emoji only after the user has used them.'],
  ] as const)('renders the %s emoji policy', (emoji, instruction) => {
    expect(assembleSystemPrompt('', { ...personality, emoji })).toContain(instruction);
  });

  it.each([
    ['lowercase', 'Text in lowercase, always.'],
    ['natural', 'Use natural sentence casing.'],
  ] as const)('renders the %s casing policy', (casing, instruction) => {
    expect(assembleSystemPrompt('', { ...personality, casing })).toContain(instruction);
  });

  it.each([
    ['no_full_stop', 'Do not end a reply with a full stop.'],
    ['natural', 'Use final punctuation naturally'],
  ] as const)('renders the %s punctuation policy', (finalPunctuation, instruction) => {
    expect(assembleSystemPrompt('', { ...personality, finalPunctuation })).toContain(instruction);
  });

  it.each([
    ['off', 'Do not swear'],
    ['tasteful', 'Save it for the rare moment'],
    ['mirror', 'Match their level'],
    ['filthy', 'Swearing is encouraged'],
  ] as const)('renders the %s swearing policy', (swearing, instruction) => {
    expect(assembleSystemPrompt('', { ...personality, swearing })).toContain(instruction);
  });

  it.each([
    ['off', 'Prefer plain answers'],
    ['dry', 'subtle, dry wit'],
    ['playful', 'openly playful and quick-witted'],
  ] as const)('renders the %s wit policy', (wit, instruction) => {
    expect(assembleSystemPrompt('', { ...personality, wit })).toContain(instruction);
  });
});
