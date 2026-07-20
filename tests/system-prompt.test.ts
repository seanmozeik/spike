import { describe, expect, it } from 'vitest';

import { assembleSystemPrompt, DEFAULT_USER_CONTEXT } from '../src/system-prompt';

const personality = {
  casing: 'lowercase',
  emoji: 'after_user',
  finalPunctuation: 'no_full_stop',
  preferredName: null,
  swearing: 'tasteful',
  timezone: 'Europe/London',
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
    expect(prompt).toContain("The user's configured local timezone is Europe/London");
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

  it('places the configured preferred name above free-form user context', () => {
    const assembled = assembleSystemPrompt('Anything else Spike should know.', {
      ...personality,
      preferredName: 'Sean',
    });
    const nameInstruction = 'The user has asked you to call them Sean.';
    expect(assembled).toContain(nameInstruction);
    expect(assembled.indexOf(nameInstruction)).toBeLessThan(assembled.indexOf('User context'));
    expect(assembleSystemPrompt('', personality)).not.toContain('asked you to call them');
  });

  it('does not add an empty context section', () => {
    expect(assembleSystemPrompt(' \n ', personality)).not.toContain('User context');
    expect(DEFAULT_USER_CONTEXT).not.toMatch(/\bS(?:ean)\b/u);
  });

  it('assembles schedule consent, clarification, and privacy invariants', () => {
    const prompt = assembleSystemPrompt('', personality);
    expect(prompt).toContain(
      'when the user explicitly asks for a reminder, recurring task, cron, or future execution',
    );
    expect(prompt).toContain('create it without asking for redundant confirmation');
    expect(prompt).toContain('ask whether they want you to schedule it and wait for a clear yes');
    expect(prompt).toContain(
      'Never create a schedule merely because a message contains a date or time',
    );
    expect(prompt).toContain(
      'Clarify any date or time that cannot be anchored to one exact instant',
    );
    expect(prompt).toContain('Confirm the effective local time and recurrence in plain language');
    expect(prompt).toContain('Schedule IDs are internal and must never appear in a reply');
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
