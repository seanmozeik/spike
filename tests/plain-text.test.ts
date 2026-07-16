import { expect, it } from 'vitest';

import { applyPlainTextFallback } from '../src/delivery/plain-text';

it('leaves plain text and bare URLs unchanged', () => {
  expect(applyPlainTextFallback('first sentence. casual ending')).toBe(
    'first sentence. casual ending',
  );
  expect(applyPlainTextFallback('details at https://example.com/path?mode=fast')).toBe(
    'details at https://example.com/path?mode=fast',
  );
});

it('replaces em and en dashes at the transport boundary', () => {
  expect(applyPlainTextFallback('one—two–three')).toBe('one, two, three');
});

it('removes a final full stop but preserves other punctuation', () => {
  expect(applyPlainTextFallback('first sentence. casual ending.')).toBe(
    'first sentence. casual ending',
  );
  expect(applyPlainTextFallback('still coming?')).toBe('still coming?');
  expect(applyPlainTextFallback('perfect!')).toBe('perfect!');
  expect(applyPlainTextFallback('compacting...')).toBe('compacting...');
});

it('falls back to stripping Markdown if the model violates the plain-text contract', () => {
  expect(
    applyPlainTextFallback(`# Result

- **first** item
2. _second_ item
> read [the source](https://example.com/source)

| Name | Value |
| --- | --- |
| mode | \`fast\` |

\`\`\`ts
const answer = 42;
\`\`\``),
  ).toBe(`Result

first item
second item
read the source: https://example.com/source

Name; Value
mode; fast

const answer = 42;`);
});
