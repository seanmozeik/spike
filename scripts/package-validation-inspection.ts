import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

interface PackageManifestEntry {
  readonly mode: 0o644 | 0o755;
  readonly path: string;
}

const packageManifest = [
  { mode: 0o644, path: 'LICENSE' },
  { mode: 0o644, path: 'README.md' },
  { mode: 0o644, path: 'SECURITY.md' },
  { mode: 0o755, path: 'dist/spike' },
  { mode: 0o755, path: 'dist/spike-like' },
  { mode: 0o644, path: 'examples/codex/custom-provider.toml' },
  { mode: 0o644, path: 'examples/codex/lm-studio.toml' },
  { mode: 0o644, path: 'examples/codex/mcp-and-hooks.toml' },
  { mode: 0o644, path: 'examples/codex/ollama.toml' },
  { mode: 0o644, path: 'examples/codex/openai.toml' },
  { mode: 0o644, path: 'examples/spike.config.toml' },
  { mode: 0o644, path: 'package.json' },
] as const satisfies readonly PackageManifestEntry[];

interface InstalledFile {
  readonly absolutePath: string;
  readonly mode: number;
  readonly relativePath: string;
}

interface InstalledTree {
  readonly directories: readonly string[];
  readonly files: readonly InstalledFile[];
}

const comparePaths = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const permissionMode = (mode: bigint): number => Number(mode % 0o1_0000n);

const assertManifestMode = (relativePath: string, actualMode: number | undefined): void => {
  const expected = packageManifest.find(({ path: expectedPath }) => expectedPath === relativePath);
  if (expected === undefined) {
    throw new Error(`release package mode has no manifest entry: ${relativePath}`);
  }
  assert.equal(
    actualMode,
    expected.mode,
    `release package mode mismatch: ${relativePath} expected ${expected.mode.toString(8)}, got ${actualMode?.toString(8) ?? 'missing'}`,
  );
};

const manifestDirectories = (): readonly string[] => {
  const directories = new Set<string>();
  for (const file of packageManifest) {
    let directory = path.dirname(file.path);
    while (directory !== '.') {
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  return [...directories].toSorted();
};

const inspectTreeEntries = async (installedRoot: string): Promise<InstalledTree> => {
  const visit = async (directory: string): Promise<InstalledTree> => {
    const names = await readdir(directory);
    const entries = await Promise.all(
      names.toSorted().map(async (name): Promise<InstalledTree> => {
        const absolutePath = path.join(directory, name);
        const relativePath = path.relative(installedRoot, absolutePath);
        const stats = await lstat(absolutePath, { bigint: true });
        if (stats.isSymbolicLink()) {
          throw new Error(`release package contains a symbolic link: ${relativePath}`);
        }
        if (stats.isDirectory()) {
          const nested = await visit(absolutePath);
          return { directories: [relativePath, ...nested.directories], files: nested.files };
        }
        if (!stats.isFile()) {
          throw new Error(`release package contains a special filesystem entry: ${relativePath}`);
        }
        if (stats.nlink !== 1n) {
          throw new Error(`release package contains a hard-linked file: ${relativePath}`);
        }
        return {
          directories: [],
          files: [{ absolutePath, mode: permissionMode(stats.mode), relativePath }],
        };
      }),
    );
    return {
      directories: entries.flatMap(({ directories }) => directories),
      files: entries.flatMap(({ files }) => files),
    };
  };
  const tree = await visit(installedRoot);
  return {
    directories: tree.directories.toSorted(),
    files: tree.files.toSorted((left, right) =>
      comparePaths(left.relativePath, right.relativePath),
    ),
  };
};

const assertManifest = (tree: InstalledTree): void => {
  assert.deepEqual(tree.directories, manifestDirectories(), 'release package directory manifest');
  assert.deepEqual(
    tree.files.map(({ relativePath }) => relativePath),
    packageManifest.map(({ path: relativePath }) => relativePath).toSorted(),
    'release package file manifest',
  );
  for (const expected of packageManifest) {
    const actual = tree.files.find(({ relativePath }) => relativePath === expected.path);
    assertManifestMode(expected.path, actual?.mode);
  }
};

const assertPrivateLiteralsExcluded = async (
  sourceRoots: readonly string[],
  files: readonly InstalledFile[],
): Promise<void> => {
  const privateLiterals = ['/Users/', ...sourceRoots, 'Mobile Documents/iCloud', '/dev/vault'];
  await Promise.all(
    files.map(async (file) => {
      const contents = await readFile(file.absolutePath);
      const text = contents.toString('utf8');
      for (const literal of privateLiterals) {
        assert.equal(text.includes(literal), false, `${file.relativePath}: ${literal}`);
      }
    }),
  );
};

const inspectInstalledTree = async (
  installedRoot: string,
  sourceRoots: readonly string[],
): Promise<void> => {
  const tree = await inspectTreeEntries(installedRoot);
  assertManifest(tree);
  await assertPrivateLiteralsExcluded(sourceRoots, tree.files);
};

export { assertManifestMode, inspectInstalledTree, packageManifest, permissionMode };
