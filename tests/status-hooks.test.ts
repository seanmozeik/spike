import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { checkHooks } from '../src/status/hooks-check';

const roots: string[] = [];

const home = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-hooks-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it('reports disabled hooks as a valid no-hook configuration', async () => {
  await expect(checkHooks(home(), { features: {} })).resolves.toEqual({
    detail: 'none configured',
    name: 'hooks',
    state: 'pass',
  });
});

it('distinguishes an available hook file from a missing enabled hook file', async () => {
  const codexHome = home();
  await expect(checkHooks(codexHome, { features: { hooks: true } })).resolves.toEqual({
    detail: 'hooks enabled but no hook file is available',
    name: 'hooks',
    state: 'fail',
  });

  writeFileSync(path.join(codexHome, 'hooks.json'), '{}');
  await expect(checkHooks(codexHome, { features: { plugin_hooks: true } })).resolves.toEqual({
    detail: 'configured hook file available',
    name: 'hooks',
    state: 'pass',
  });
});
