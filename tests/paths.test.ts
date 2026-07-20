import { describe, expect, it, vi } from 'vitest';

import { attachmentRoots } from '../src/attachments/roots';
import { spikePaths } from '../src/paths';

describe('spike paths', () => {
  it('keeps config, state, socket, logs, and CODEX_HOME under one root', () => {
    const paths = spikePaths('/tmp/spike-fixture');
    expect(paths.config).toBe('/tmp/spike-fixture/config.toml');
    expect(paths.database).toBe('/tmp/spike-fixture/state/spike.db');
    expect(paths.attachments).toBe('/tmp/spike-fixture/state/attachments');
    expect(paths.socket).toBe('/tmp/spike-fixture/run/spike.sock');
    expect(paths.daemonLog).toBe('/tmp/spike-fixture/logs/daemon.log');
    expect(paths.codexConfig).toBe('/tmp/spike-fixture/codex-home/config.toml');
    expect(paths.accounts).toBe('/tmp/spike-fixture/accounts');
    expect(paths.prompt).toBe('/tmp/spike-fixture/prompt.md');
  });

  it('defaults to the canonical Spike config home', () => {
    vi.stubEnv('SPIKE_HOME', '');
    try {
      expect(spikePaths().root).toMatch(/\/\.config\/spike$/u);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stages model-visible attachments inside the configured working directory', () => {
    expect(
      attachmentRoots('/Users/test/Library/Messages/chat.db', '/Users/test/spike-work'),
    ).toEqual({
      attachmentSourceRoot: '/Users/test/Library/Messages/Attachments',
      attachmentStagingRoot: '/Users/test/spike-work/tmp/attachments',
    });
  });
});
