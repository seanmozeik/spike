import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { detachReleaseArchive } from '../scripts/package-validation-release';

it('detaches the archive and removes the complete temporary source tree', async () => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), 'spike-release-detach-'));
  const sourceRoot = path.join(validationRoot, 'source');
  const builtArchive = path.join(sourceRoot, 'artifacts', 'spike-fixture.tar.gz');
  try {
    await Promise.all([
      mkdir(path.dirname(builtArchive), { recursive: true }),
      mkdir(path.join(sourceRoot, 'node_modules', 'fixture'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(builtArchive, 'release archive'),
      writeFile(path.join(sourceRoot, 'node_modules', 'fixture', 'source-only'), 'source'),
    ]);

    const detachedArchive = await detachReleaseArchive(validationRoot, sourceRoot, builtArchive);

    expect(detachedArchive).toBe(path.join(validationRoot, 'release', 'spike-fixture.tar.gz'));
    expect(await readFile(detachedArchive, 'utf8')).toBe('release archive');
    expect(await readdir(validationRoot)).toEqual(['release']);
  } finally {
    await rm(validationRoot, { force: true, recursive: true });
  }
});
