import { Database } from 'bun:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Effect } from 'effect';

import { loadSpikeConfig, type SpikeConfig } from '../app-config';
import { inspectJournal } from '../database';
import { guiDomain, launchAgentLabel, runLaunchctl } from '../launchd';
import type { SpikePaths } from '../paths';
import { checkHooks } from './hooks-check';

type CheckState = 'fail' | 'pass' | 'warn';
const AUTOMATION_TIMEOUT_MS = 3000;

interface DiagnosticCheck {
  readonly detail: string;
  readonly name: string;
  readonly state: CheckState;
}

interface DoctorReport {
  readonly checks: readonly DiagnosticCheck[];
  readonly healthy: boolean;
  readonly ok: true;
}

type DiagnosticConfig =
  | { readonly app: SpikeConfig; readonly codex: Record<string, unknown>; readonly error: null }
  | { readonly app: null; readonly codex: null; readonly error: string };

const check = (name: string, state: CheckState, detail: string): DiagnosticCheck => ({
  detail,
  name,
  state,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseObject = (text: string): Record<string, unknown> => {
  const value: unknown = Bun.TOML.parse(text);
  if (!isObject(value)) {
    throw new Error('expected a TOML table');
  }
  return value;
};

const mcpCheck = (codex: Record<string, unknown>): DiagnosticCheck => {
  const servers = isObject(codex['mcp_servers']) ? codex['mcp_servers'] : {};
  const names = Object.keys(servers);
  return check('mcps', 'pass', names.length === 0 ? 'none configured' : names.join(', '));
};

const loadDiagnosticConfig = async (paths: SpikePaths): Promise<DiagnosticConfig> => {
  try {
    const app = await Effect.runPromise(loadSpikeConfig(paths));
    const codexConfigPath = path.join(app.codexHome, 'config.toml');
    const codexText = await readFile(codexConfigPath, 'utf8');
    const codex = parseObject(codexText);
    return { app, codex, error: null };
  } catch (error) {
    return {
      app: null,
      codex: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const configChecks = async (config: DiagnosticConfig): Promise<readonly DiagnosticCheck[]> => {
  if (config.error === null) {
    const { app, codex } = config;
    const hooks = await checkHooks(app.codexHome, codex);
    return [check('config', 'pass', `${app.handle} / ${app.chatGuid}`), mcpCheck(codex), hooks];
  }
  return [
    check('config', 'fail', config.error),
    check('mcps', 'fail', 'Codex config unavailable'),
    check('hooks', 'fail', 'Codex hooks unavailable'),
  ];
};

const journalCheck = (paths: SpikePaths): DiagnosticCheck => {
  try {
    const info = inspectJournal(paths.database);
    return check('journal', 'pass', `schema ${String(info.migrationVersion)} ${info.journalMode}`);
  } catch (error) {
    return check('journal', 'fail', error instanceof Error ? error.message : String(error));
  }
};

const durableAccountCheck = async (paths: SpikePaths): Promise<DiagnosticCheck> => {
  try {
    const entries = await readdir(paths.accounts, { withFileTypes: true });
    const accounts = entries.filter((entry) => entry.isDirectory());
    const snapshots = await Promise.all(
      accounts.map((entry) =>
        Bun.file(path.join(paths.accounts, entry.name, 'auth.json')).exists(),
      ),
    );
    const eligible = snapshots.filter(Boolean).length;
    return check('accounts', eligible > 0 ? 'pass' : 'fail', `${String(eligible)} eligible`);
  } catch (error) {
    return check('accounts', 'fail', error instanceof Error ? error.message : String(error));
  }
};

const messagesChecks = (app: SpikeConfig | null): readonly DiagnosticCheck[] => {
  const expectedGuid = app?.chatGuid ?? '';
  const chatDatabase = app?.messagesDatabase ?? 'unconfigured';
  const checks: DiagnosticCheck[] = [];
  try {
    const database = new Database(chatDatabase, { readonly: true, strict: true });
    try {
      checks.push(check('chat.db FDA', 'pass', chatDatabase));
      const row = database
        .query<{ guid: string }, [string]>('SELECT guid FROM chat WHERE guid = ? LIMIT 1')
        .get(expectedGuid);
      checks.push(
        check(
          'configured conversation',
          row?.guid === expectedGuid && expectedGuid !== '' ? 'pass' : 'fail',
          row?.guid ?? `not found: ${expectedGuid === '' ? 'unconfigured' : expectedGuid}`,
        ),
      );
    } finally {
      database.close();
    }
  } catch (error) {
    checks.push(
      check('chat.db FDA', 'fail', error instanceof Error ? error.message : String(error)),
      check('configured conversation', 'fail', 'chat.db unavailable'),
    );
  }
  const automation = Bun.spawnSync(['osascript', '-e', 'tell application "Messages" to get name'], {
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: AUTOMATION_TIMEOUT_MS,
  });
  checks.push(
    check(
      'Messages Automation',
      automation.exitCode === 0 ? 'pass' : 'fail',
      automation.exitCode === 0
        ? automation.stdout.toString().trim() || 'allowed'
        : automation.stderr.toString().trim() || 'denied',
    ),
  );
  return checks;
};

const accessibilityChecks = (helperPath: string): readonly DiagnosticCheck[] => {
  try {
    const result = Bun.spawnSync([helperPath, '--status'], { stderr: 'pipe', stdout: 'pipe' });
    if (result.exitCode !== 0) {
      return [
        check('Accessibility', 'warn', result.stderr.toString().trim() || 'helper unavailable'),
        check('lock state', 'warn', 'unknown'),
      ];
    }
    const status: unknown = JSON.parse(result.stdout.toString());
    if (!isObject(status)) {
      throw new Error('Accessibility helper returned a non-object response');
    }
    const trusted = status['accessibilityTrusted'] === true;
    const locked = status['locked'] === true;
    return [
      check('Accessibility', trusted ? 'pass' : 'warn', trusted ? 'trusted' : 'unavailable'),
      check('lock state', locked ? 'warn' : 'pass', locked ? 'locked' : 'unlocked'),
    ];
  } catch (error) {
    return [
      check('Accessibility', 'warn', error instanceof Error ? error.message : String(error)),
      check('lock state', 'warn', 'unknown'),
    ];
  }
};

const launchdCheck = async (
  paths: SpikePaths,
  config: SpikeConfig | null,
): Promise<DiagnosticCheck> => {
  const loaded = runLaunchctl(['print', `${guiDomain()}/${launchAgentLabel}`]);
  let plist = '';
  try {
    plist = await readFile(paths.launchAgent, 'utf8');
  } catch {
    // Missing plist is reported by the failed context check below.
  }
  const plistMatches =
    config !== null &&
    plist.includes(launchAgentLabel) &&
    plist.includes(paths.root) &&
    plist.includes(config.codexHome) &&
    plist.includes('CODEX_EXECUTABLE') &&
    plist.includes('<key>PATH</key>');
  const loadedContextMatches =
    loaded.stdout.includes(paths.root) &&
    loaded.stdout.includes('CODEX_EXECUTABLE') &&
    loaded.stdout.includes('PATH =>');
  const valid = loaded.exitCode === 0 && plistMatches && loadedContextMatches;
  return check(
    'LaunchAgent context',
    valid ? 'pass' : 'fail',
    valid ? `${launchAgentLabel} loaded with isolated home` : 'missing or stale launchd context',
  );
};

const makeDoctorReport = async (
  paths: SpikePaths,
  controlStatus: unknown,
  helperPath: string,
): Promise<DoctorReport> => {
  const status = isObject(controlStatus) ? controlStatus : {};
  const config = await loadDiagnosticConfig(paths);
  const [configuration, launchd, durableAccounts] = await Promise.all([
    configChecks(config),
    launchdCheck(paths, config.app),
    durableAccountCheck(paths),
  ]);
  const messages = messagesChecks(config.app);
  const journal = journalCheck(paths);
  const appServer = isObject(status['appServer']) ? status['appServer'] : {};
  const account = isObject(status['account']) ? status['account'] : {};
  const liveEligible = typeof account['eligible'] === 'number' ? account['eligible'] : null;
  const accounts =
    liveEligible === null
      ? durableAccounts
      : check('accounts', liveEligible > 0 ? 'pass' : 'fail', `${String(liveEligible)} eligible`);
  const checks = [
    ...configuration,
    check('control socket', status['ok'] === true ? 'pass' : 'fail', paths.socket),
    journal,
    check(
      'app-server',
      appServer['healthy'] === true ? 'pass' : 'fail',
      appServer['healthy'] === true ? 'responsive' : 'unavailable',
    ),
    accounts,
    ...messages,
    ...accessibilityChecks(helperPath),
    launchd,
  ];
  return { checks, healthy: !checks.some((item) => item.state === 'fail'), ok: true };
};

const isDoctorReport = (value: unknown): value is DoctorReport =>
  isObject(value) && value['ok'] === true && Array.isArray(value['checks']);

export { isDoctorReport, makeDoctorReport };
export type { DiagnosticCheck, DoctorReport };
