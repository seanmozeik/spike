import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { changedTreePaths, snapshotTree } from '../scripts/package-validation-tree';

it('ignores only named top-level caches while detecting source mutations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spike-source-snapshot-'));
  const cache = path.join(root, 'node_modules');
  const source = path.join(root, 'source.ts');
  try {
    await mkdir(cache);
    await Promise.all([
      writeFile(path.join(cache, 'cache.txt'), 'before'),
      writeFile(source, 'before'),
    ]);
    const options = { ignoredTopLevel: new Set(['node_modules']) };
    const before = await snapshotTree(root, options);

    await writeFile(path.join(cache, 'cache.txt'), 'after');
    expect(changedTreePaths(before, await snapshotTree(root, options))).toEqual([]);

    await writeFile(source, 'after');
    expect(changedTreePaths(before, await snapshotTree(root, options))).toEqual(['source.ts']);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
