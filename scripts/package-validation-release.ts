import assert from 'node:assert/strict';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const detachReleaseArchive = async (
  validationRoot: string,
  sourceRoot: string,
  builtArchive: string,
): Promise<string> => {
  assert.equal(sourceRoot, path.join(validationRoot, 'source'));
  assert.equal(path.dirname(builtArchive), path.join(sourceRoot, 'artifacts'));
  const releaseDirectory = path.join(validationRoot, 'release');
  const detachedArchive = path.join(releaseDirectory, path.basename(builtArchive));
  await mkdir(releaseDirectory, { mode: 0o700, recursive: true });
  await copyFile(builtArchive, detachedArchive);
  await rm(sourceRoot, { recursive: true });
  return detachedArchive;
};

export { detachReleaseArchive };
