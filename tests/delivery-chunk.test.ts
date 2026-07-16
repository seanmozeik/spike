import { expect, it } from 'vitest';

import { chunkFinalAnswer } from '../src/delivery/chunk';

it('keeps ordinary assistant messages in one bubble', () => {
  expect(chunkFinalAnswer('short answer')).toEqual(['short answer']);
});

it('splits long finals by paragraph, line, word, then hard length', () => {
  const text = `first paragraph\n\nsecond line with words\n${'x'.repeat(25)}`;
  const chunks = chunkFinalAnswer(text, 20);
  expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
  expect(chunks).toEqual([
    'first paragraph',
    'second line with',
    'words',
    'xxxxxxxxxxxxxxxxxxxx',
    'xxxxx',
  ]);
});

it('never bisects a surrogate-pair emoji at a hard boundary', () => {
  expect(chunkFinalAnswer(`1234😀tail`, 5)).toEqual(['1234', '😀tai', 'l']);
});
