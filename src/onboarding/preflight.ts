import { existsSync } from 'node:fs';
import path from 'node:path';

interface PreflightReport {
  readonly bunExecutable: string;
  readonly codexExecutable: string;
  readonly messagesDatabase: string;
}

const MINIMUM_BUN_MINOR = 3;

const versionParts = (value: string): readonly number[] =>
  value.split('.').map((part) => Math.trunc(Number(part)));

const bunVersionSupported = (version: string): boolean => {
  const [major = 0, minor = 0] = versionParts(version);
  return major > 1 || (major === 1 && minor >= MINIMUM_BUN_MINOR);
};

const runPreflight = (): PreflightReport => {
  if (process.platform !== 'darwin') {
    throw new Error('Spike requires macOS');
  }
  if (!bunVersionSupported(Bun.version)) {
    throw new Error(`Spike requires Bun 1.3+; found ${Bun.version}`);
  }
  if (!existsSync('/System/Applications/Messages.app')) {
    throw new Error('Messages.app is not installed');
  }
  const codexExecutable = Bun.which('codex');
  if (codexExecutable === null) {
    throw new Error('Codex is not installed or is missing from PATH');
  }
  return {
    bunExecutable: process.execPath,
    codexExecutable,
    messagesDatabase: path.join(process.env['HOME'] ?? '', 'Library', 'Messages', 'chat.db'),
  };
};

const requestMessagesAutomation = (): void => {
  const result = Bun.spawnSync(['osascript', '-e', 'tell application "Messages" to get name'], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      'Messages Automation is not approved. Allow Bun to control Messages in System Settings, then retry.',
    );
  }
};

const requestAccessibility = (): void => {
  const helper =
    process.env['SPIKE_LIKE_HELPER'] ??
    path.join(path.dirname(process.argv[1] ?? import.meta.filename), 'spike-like');
  const result = Bun.spawnSync([helper, '--status'], { stderr: 'pipe', stdout: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || 'Spike’s Like helper is unavailable');
  }
  const status: unknown = JSON.parse(result.stdout.toString());
  if (
    typeof status !== 'object' ||
    status === null ||
    Reflect.get(status, 'accessibilityTrusted') !== true
  ) {
    throw new Error(`Accessibility is not approved for Spike’s Like helper:\n${helper}`);
  }
};

const openFullDiskAccessSettings = (): void => {
  Bun.spawnSync([
    'open',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  ]);
};

const openAccessibilitySettings = (): void => {
  Bun.spawnSync([
    'open',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  ]);
};

const openAutomationSettings = (): void => {
  Bun.spawnSync([
    'open',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  ]);
};

export {
  bunVersionSupported,
  openAccessibilitySettings,
  openAutomationSettings,
  openFullDiskAccessSettings,
  requestAccessibility,
  requestMessagesAutomation,
  runPreflight,
};
export type { PreflightReport };
