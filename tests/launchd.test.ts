import { describe, expect, it } from 'vitest';

import { buildLaunchAgent, launchAgentLabel } from '../src/launchd';
import { spikePaths } from '../src/paths';

describe('LaunchAgent', () => {
  it('pins the exact Bun, entrypoint, CODEX_HOME, and log paths', () => {
    const paths = spikePaths('/tmp/spike&fixture');
    const plist = buildLaunchAgent({
      bun: '/opt/homebrew/bin/bun',
      codex: '/opt/homebrew/bin/codex',
      codexHome: '/tmp/spike&fixture/codex-home',
      path: '/home/example/.local/bin:/opt/homebrew/bin:/usr/bin:/bin',
      paths,
      program: '/tmp/cli.ts',
    });
    expect(plist).toContain(launchAgentLabel);
    expect(plist).toContain('/opt/homebrew/bin/bun');
    expect(plist).toContain('/tmp/cli.ts');
    expect(plist).toContain('CODEX_EXECUTABLE');
    expect(plist).toContain('SPIKE_HOME');
    expect(plist).toContain('/opt/homebrew/bin/codex');
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('/home/example/.local/bin:/opt/homebrew/bin:/usr/bin:/bin');
    expect(plist).toContain('/tmp/spike&amp;fixture/codex-home');
    expect(plist).toContain('/tmp/spike&amp;fixture/logs/daemon.log');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
  });
});
