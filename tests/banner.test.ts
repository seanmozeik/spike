import { describe, expect, it } from 'vitest';

import { renderBanner, shouldShowCliBanner, SPIKE_BANNER } from '../src/ui/banner';

describe('Spike banner', () => {
  it('renders the escaped figlet art as plain text', () => {
    expect(renderBanner(false)).toBe(SPIKE_BANNER);
    expect(SPIKE_BANNER).toContain(String.raw`/  ___/\____ \|`);
    expect(SPIKE_BANNER).toContain(String.raw`\/ |__|           \/    \/`);
    expect(renderBanner(false)).not.toContain('\u001B[');
  });

  it.each([
    { arguments: [], expected: true },
    { arguments: ['--help'], expected: true },
    { arguments: ['-h'], expected: true },
    { arguments: ['--version'], expected: true },
    { arguments: ['-v'], expected: true },
    { arguments: ['doctor', '--json'], expected: false },
    { arguments: ['serve'], expected: false },
    { arguments: ['init', '--preview'], expected: false },
  ])('selects human-facing CLI arguments: $arguments', ({ arguments: arguments_, expected }) => {
    expect(shouldShowCliBanner(arguments_)).toBe(expected);
  });
});
