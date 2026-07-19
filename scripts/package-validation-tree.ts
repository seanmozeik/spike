import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

interface TreeSnapshotEntry {
  readonly contentHash?: string;
  readonly ctimeNs: string;
  readonly kind: 'directory' | 'file' | 'symlink';
  readonly linkTarget?: string;
  readonly mode: number;
  readonly mtimeNs: string;
  readonly path: string;
  readonly size: string;
}

interface SnapshotTreeOptions {
  readonly ignoredTopLevel?: ReadonlySet<string>;
}

const snapshotEntry = async (root: string, absolutePath: string): Promise<TreeSnapshotEntry> => {
  const stats = await lstat(absolutePath, { bigint: true });
  const common = {
    ctimeNs: stats.ctimeNs.toString(),
    mode: Number(stats.mode),
    mtimeNs: stats.mtimeNs.toString(),
    path: path.relative(root, absolutePath) || '.',
    size: stats.size.toString(),
  };
  if (stats.isDirectory()) {
    return { ...common, kind: 'directory' };
  }
  if (stats.isFile()) {
    return {
      ...common,
      contentHash: createHash('sha256')
        .update(await readFile(absolutePath))
        .digest('hex'),
      kind: 'file',
    };
  }
  if (stats.isSymbolicLink()) {
    return { ...common, kind: 'symlink', linkTarget: await readlink(absolutePath) };
  }
  throw new Error(`unsupported temporary filesystem entry: ${common.path}`);
};

const snapshotTree = (
  root: string,
  options: SnapshotTreeOptions = {},
): Promise<readonly TreeSnapshotEntry[]> => {
  const visit = async (absolutePath: string): Promise<readonly TreeSnapshotEntry[]> => {
    const entry = await snapshotEntry(root, absolutePath);
    if (entry.kind !== 'directory') {
      return [entry];
    }
    const directoryEntries = await readdir(absolutePath);
    const names = directoryEntries.filter(
      (name) => absolutePath !== root || options.ignoredTopLevel?.has(name) !== true,
    );
    const children = await Promise.all(
      names.toSorted().map((child) => visit(path.join(absolutePath, child))),
    );
    return [entry, ...children.flat()];
  };
  return visit(root);
};

const changedTreePaths = (
  before: readonly TreeSnapshotEntry[],
  after: readonly TreeSnapshotEntry[],
): readonly string[] => {
  const previous = new Map(before.map((entry) => [entry.path, JSON.stringify(entry)]));
  const current = new Map(after.map((entry) => [entry.path, JSON.stringify(entry)]));
  return [...new Set([...previous.keys(), ...current.keys()])]
    .filter((entryPath) => previous.get(entryPath) !== current.get(entryPath))
    .toSorted();
};

export { changedTreePaths, snapshotTree };
export type { SnapshotTreeOptions, TreeSnapshotEntry };
