import { expect, it } from 'vitest';

import { updateFormula } from '../scripts/release-formula';

const formula = `class Spike < Formula
  url "https://github.com/seanmozeik/spike/releases/download/v0.0.0/spike-0.0.0.tar.gz"
  version "0.0.0"
  sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
end
`;

it('updates the one canonical release identity', () => {
  const updated = updateFormula(formula, {
    sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    version: '0.0.1',
  });

  expect(updated).toContain(
    'url "https://github.com/seanmozeik/spike/releases/download/v0.0.1/spike-0.0.1.tar.gz"',
  );
  expect(updated).toContain('version "0.0.1"');
  expect(updated).toContain(
    'sha256 "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
  );
});

it('fails closed when a canonical field is missing or duplicated', () => {
  const identity = {
    sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    version: '0.0.1',
  };

  expect(() => updateFormula(formula.replace(/^\s*version.*$/mu, ''), identity)).toThrow(
    'exactly one version',
  );
  expect(() => updateFormula(`${formula}${formula}`, identity)).toThrow('found 2');
});
