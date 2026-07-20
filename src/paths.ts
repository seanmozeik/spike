import { homedir } from 'node:os';
import path from 'node:path';

export interface SpikePaths {
  readonly root: string;
  readonly config: string;
  readonly codexHome: string;
  readonly codexConfig: string;
  readonly codexHooks: string;
  readonly prompt: string;
  readonly accounts: string;
  readonly state: string;
  readonly attachments: string;
  readonly database: string;
  readonly run: string;
  readonly socket: string;
  readonly logs: string;
  readonly daemonLog: string;
  readonly launchAgent: string;
}

export const spikePaths = (root = process.env['SPIKE_HOME']): SpikePaths => {
  const normalizedRoot = root?.trim();
  const resolvedRoot =
    normalizedRoot === undefined || normalizedRoot === ''
      ? path.join(homedir(), '.config', 'spike')
      : normalizedRoot;
  const state = path.join(resolvedRoot, 'state');
  const run = path.join(resolvedRoot, 'run');
  const logs = path.join(resolvedRoot, 'logs');
  const codexHome = path.join(resolvedRoot, 'codex-home');
  return {
    accounts: path.join(resolvedRoot, 'accounts'),
    attachments: path.join(state, 'attachments'),
    codexConfig: path.join(codexHome, 'config.toml'),
    codexHome,
    codexHooks: path.join(codexHome, 'hooks.json'),
    config: path.join(resolvedRoot, 'config.toml'),
    daemonLog: path.join(logs, 'daemon.log'),
    database: path.join(state, 'spike.db'),
    launchAgent: path.join(homedir(), 'Library', 'LaunchAgents', 'com.mozeik.spike.plist'),
    logs,
    prompt: path.join(resolvedRoot, 'prompt.md'),
    root: resolvedRoot,
    run,
    socket: path.join(run, 'spike.sock'),
    state,
  };
};
