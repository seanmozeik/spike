import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SpikePaths } from './paths';

const launchAgentLabel = 'com.mozeik.spike';
const FALLBACK_UID = 501;
const LAUNCHCTL_TIMEOUT_MS = 10_000;

const xmlEscape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const xmlString = (value: string): string => `<string>${xmlEscape(value)}</string>`;

interface LaunchAgentOptions {
  readonly bun: string;
  readonly codex: string;
  readonly codexHome: string;
  readonly path: string;
  readonly program: string;
  readonly paths: SpikePaths;
}

const buildLaunchAgent = ({
  bun,
  codex,
  codexHome,
  path: executablePath,
  paths,
  program,
}: LaunchAgentOptions): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${xmlString(launchAgentLabel)}
  <key>ProgramArguments</key>
  <array>${xmlString(bun)}${xmlString(program)}${xmlString('serve')}</array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SPIKE_HOME</key>${xmlString(paths.root)}
    <key>CODEX_HOME</key>${xmlString(codexHome)}
    <key>CODEX_EXECUTABLE</key>${xmlString(codex)}
    <key>PATH</key>${xmlString(executablePath)}
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key>${xmlString('Interactive')}
  <key>StandardOutPath</key>${xmlString(paths.daemonLog)}
  <key>StandardErrorPath</key>${xmlString(paths.daemonLog)}
</dict>
</plist>
`;

const writeLaunchAgent = async (options: LaunchAgentOptions): Promise<void> => {
  await mkdir(path.dirname(options.paths.launchAgent), { recursive: true });
  await writeFile(options.paths.launchAgent, buildLaunchAgent(options), 'utf8');
};

interface ProcessResult {
  readonly exitCode: number;
  readonly signalCode: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const runLaunchctl = (args: readonly string[]): ProcessResult => {
  // The synchronous boundary returns only after Bun has reaped the bounded command process.
  const result = Bun.spawnSync(['launchctl', ...args], {
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: LAUNCHCTL_TIMEOUT_MS,
  });
  return {
    exitCode: result.exitCode,
    signalCode: result.signalCode ?? null,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
    timedOut: result.exitedDueToTimeout === true,
  };
};

const guiDomain = (uid = process.getuid?.() ?? FALLBACK_UID): string => `gui/${uid}`;

export { buildLaunchAgent, guiDomain, launchAgentLabel, runLaunchctl, writeLaunchAgent };
export type { LaunchAgentOptions, ProcessResult };
