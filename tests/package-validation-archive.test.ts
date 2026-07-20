import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
  assertExtractedArchiveRoot,
  validateArchiveMembers,
} from '../scripts/package-validation-archive';

const expectedRoot = 'spike-0.0.1';

it('accepts only canonical members beneath the single release root', () => {
  expect(() => {
    validateArchiveMembers(
      `${expectedRoot}/\n${expectedRoot}/dist/\n${expectedRoot}/dist/spike\n`,
      expectedRoot,
    );
  }).not.toThrow();
  expect(() => {
    validateArchiveMembers(`/tmp/escape\n`, expectedRoot);
  }).toThrow('absolute member');
  expect(() => {
    validateArchiveMembers(`${expectedRoot}/dist/../../escape\n`, expectedRoot);
  }).toThrow('parent traversal member');
  expect(() => {
    validateArchiveMembers(`${expectedRoot}/./dist/spike\n`, expectedRoot);
  }).toThrow('non-canonical member');
  expect(() => {
    validateArchiveMembers(`${expectedRoot}/dist/spike\nsibling/file\n`, expectedRoot);
  }).toThrow(`outside ${expectedRoot}: sibling/file`);
});

it('requires exactly one directory beneath the extraction prefix', async () => {
  const prefix = await mkdtemp(path.join(tmpdir(), 'spike-archive-prefix-'));
  try {
    await mkdir(path.join(prefix, expectedRoot));
    await expect(assertExtractedArchiveRoot(prefix, expectedRoot)).resolves.toBeUndefined();

    await writeFile(path.join(prefix, 'sibling'), 'unexpected');
    await expect(assertExtractedArchiveRoot(prefix, expectedRoot)).rejects.toThrow(
      'release archive extracted more than its single expected root',
    );
  } finally {
    await rm(prefix, { force: true, recursive: true });
  }
});
