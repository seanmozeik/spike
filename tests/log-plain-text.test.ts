import { describe, expect, it } from 'vitest';

import { formatLogTail, plainLogText } from '../src/logging/plain-text';

describe('plain daemon logs', () => {
  it('removes terminal control sequences from legacy content', () => {
    expect(plainLogText('\u{1B}[2mready\u{1B}[0m \u{1B}[31mERROR\u{1B}[0m')).toBe('ready ERROR');
  });

  it('drops a partial leading record and bounds output by complete lines', () => {
    const contents = 'partial record\n\u{1B}[31mfirst\u{1B}[0m\nsecond\nthird\nfourth\n';

    expect(formatLogTail(contents, { maxLines: 3, startsMidLine: true })).toBe(
      'second\nthird\nfourth',
    );
  });

  it('returns empty text for an empty log', () => {
    expect(formatLogTail('', { maxLines: 200, startsMidLine: false })).toBe('');
  });
});
