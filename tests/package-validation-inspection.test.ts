import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
  assertManifestMode,
  inspectInstalledTree,
  packageManifest,
  permissionMode,
} from '../scripts/package-validation-inspection';

const makePackageTree = async (root: string): Promise<void> => {
  await Promise.all(
    packageManifest.map(async ({ mode, path: relativePath }) => {
      const file = path.join(root, relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `fixture ${relativePath}\n`);
      await chmod(file, mode);
    }),
  );
};

it('accepts only the explicit regular-file package manifest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spike-package-tree-'));
  try {
    await makePackageTree(root);
    await expect(inspectInstalledTree(root, ['/private/source'])).resolves.toBeUndefined();

    const cli = path.join(root, 'dist', 'spike');
    await chmod(cli, 0o644);
    await expect(inspectInstalledTree(root, ['/private/source'])).rejects.toThrow(
      'release package mode mismatch: dist/spike',
    );
    await chmod(cli, 0o755);

    const likeHelper = path.join(root, 'dist', 'spike-like');
    await chmod(likeHelper, 0o644);
    await expect(inspectInstalledTree(root, ['/private/source'])).rejects.toThrow(
      'release package mode mismatch: dist/spike-like',
    );
    await chmod(likeHelper, 0o755);

    const unexpected = path.join(root, '.env');
    await writeFile(unexpected, 'unexpected\n');
    await expect(inspectInstalledTree(root, ['/private/source'])).rejects.toThrow(
      'release package file manifest',
    );
    await rm(unexpected);

    await symlink('/Users/private/source', path.join(root, 'private-link'));
    await expect(inspectInstalledTree(root, ['/private/source'])).rejects.toThrow(
      'release package contains a symbolic link: private-link',
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects the exact staged source path and its canonical macOS alias', async () => {
  const installedRoot = await mkdtemp(path.join(tmpdir(), 'spike-package-private-path-'));
  const validationRoot = await mkdtemp(path.join(tmpdir(), 'spike-package-validation-source-'));
  const stagedSourceRoot = path.join(validationRoot, 'source');
  try {
    await Promise.all([makePackageTree(installedRoot), mkdir(stagedSourceRoot)]);
    const canonicalSourceRoot = await realpath(stagedSourceRoot);
    const readme = path.join(installedRoot, 'README.md');

    await writeFile(readme, `built from ${stagedSourceRoot}\n`);
    await expect(
      inspectInstalledTree(installedRoot, [stagedSourceRoot, canonicalSourceRoot]),
    ).rejects.toThrow(`README.md: ${stagedSourceRoot}`);

    await writeFile(readme, `built from ${canonicalSourceRoot}\n`);
    await expect(inspectInstalledTree(installedRoot, [canonicalSourceRoot])).rejects.toThrow(
      `README.md: ${canonicalSourceRoot}`,
    );
  } finally {
    await Promise.all([
      rm(installedRoot, { force: true, recursive: true }),
      rm(validationRoot, { force: true, recursive: true }),
    ]);
  }
});

it('preserves and rejects every special permission bit on both executables', () => {
  const rawModes = [0o10_1755n, 0o10_2755n, 0o10_4755n, 0o10_7755n];
  for (const executable of ['dist/spike', 'dist/spike-like']) {
    for (const rawMode of rawModes) {
      const mode = permissionMode(rawMode);
      expect(() => {
        assertManifestMode(executable, mode);
      }).toThrow(
        `release package mode mismatch: ${executable} expected 755, got ${mode.toString(8)}`,
      );
    }
  }
});
