import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const validateArchiveMembers = (listing: string, expectedRoot: string): void => {
  const members = listing.split('\n').filter((member) => member !== '');
  assert.notEqual(members.length, 0, 'release archive has no members');
  for (const member of members) {
    const untrailed = member.endsWith('/') ? member.slice(0, -1) : member;
    const components = untrailed.split('/');
    assert.equal(untrailed.includes('\0'), false, `release archive has a NUL member: ${member}`);
    assert.equal(
      path.posix.isAbsolute(untrailed),
      false,
      `release archive has an absolute member: ${member}`,
    );
    assert.equal(
      components.includes('..'),
      false,
      `release archive has a parent traversal member: ${member}`,
    );
    assert.equal(
      path.posix.normalize(untrailed),
      untrailed,
      `release archive has a non-canonical member: ${member}`,
    );
    assert.equal(
      components[0],
      expectedRoot,
      `release archive member is outside ${expectedRoot}: ${member}`,
    );
  }
};

const assertExtractedArchiveRoot = async (prefix: string, expectedRoot: string): Promise<void> => {
  const entries = await readdir(prefix, { withFileTypes: true });
  assert.deepEqual(
    entries.map(({ name }) => name).toSorted(),
    [expectedRoot],
    'release archive extracted more than its single expected root',
  );
  assert.equal(
    entries[0]?.isDirectory(),
    true,
    `release archive root is not a directory: ${expectedRoot}`,
  );
};

export { assertExtractedArchiveRoot, validateArchiveMembers };
