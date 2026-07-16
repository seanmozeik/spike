import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { ensureRuntimeLayout } from '../src/config-files';
import { spikePaths } from '../src/paths';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('creates runtime directories without inventing user configuration', () =>
  Effect.gen(function* runtimeDirectories() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-config-'));
    roots.push(root);
    const paths = spikePaths(root);
    yield* ensureRuntimeLayout(paths);

    for (const directory of [
      paths.root,
      paths.codexHome,
      paths.accounts,
      paths.state,
      paths.run,
      paths.logs,
    ]) {
      expect(statSync(directory).isDirectory()).toBe(true);
    }
    expect(existsSync(paths.config)).toBe(false);
    expect(existsSync(paths.codexConfig)).toBe(false);
    expect(existsSync(paths.prompt)).toBe(false);
  }),
);
