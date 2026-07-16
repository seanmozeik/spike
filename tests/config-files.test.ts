import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

it.effect('creates fictional public defaults without inheriting a machine profile', () =>
  Effect.gen(function* publicDefaults() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-config-'));
    roots.push(root);
    const paths = spikePaths(root);
    yield* ensureRuntimeLayout(paths);

    const appConfig = readFileSync(paths.config, 'utf8');
    expect(appConfig).toContain('+15555550123');
    expect(appConfig).toContain('working_directory = "~/Documents"');
    expect(appConfig).toContain('codex_executable = "codex"');
    expect(appConfig).not.toContain('/Users/');

    const codexConfig = readFileSync(paths.codexConfig, 'utf8');
    expect(codexConfig).toContain('normal Codex configuration format');
    expect(codexConfig).not.toContain('mcp_servers');
    expect(codexConfig).not.toContain('hooks.state');

    const prompt = readFileSync(paths.prompt, 'utf8');
    expect(prompt).toContain('Add personal context here');
    expect(prompt).not.toContain('lowercase');
    expect(prompt).not.toContain('Markdown');
  }),
);

it.effect('never overwrites existing app, Codex, or prompt configuration', () =>
  Effect.gen(function* nonDestructiveUpgrade() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-upgrade-'));
    roots.push(root);
    const paths = spikePaths(root);
    yield* ensureRuntimeLayout(paths);
    writeFileSync(paths.config, 'private_app = true\n');
    writeFileSync(paths.codexConfig, 'private_codex = true\n');
    writeFileSync(paths.prompt, 'private prompt\n');

    yield* ensureRuntimeLayout(paths);

    expect(readFileSync(paths.config, 'utf8')).toBe('private_app = true\n');
    expect(readFileSync(paths.codexConfig, 'utf8')).toBe('private_codex = true\n');
    expect(readFileSync(paths.prompt, 'utf8')).toBe('private prompt\n');
  }),
);
