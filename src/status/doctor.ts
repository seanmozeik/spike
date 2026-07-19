import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Effect, Result } from 'effect';

import { loadSpikeConfig, type SpikeConfig } from '../app-config';
import { inspectJournal } from '../database';
import { guiDomain, launchAgentLabel } from '../launchd';
import { openMessagesInbox } from '../messages-inbox';
import { liveOperatorCommands, type OperatorCommandPort } from '../operator/commands';
import { classifyServiceInspection } from '../operator/lifecycle';
import type { SpikePaths } from '../paths';
import { checkAccessibility } from './accessibility-check';
import { attachmentStagingCheck } from './attachment-check';
import { checkHooks } from './hooks-check';

type CheckState = 'fail' | 'pass' | 'warn';

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

const numericField = (value: Record<string, unknown>, key: string): number =>
  typeof value[key] === 'number' ? value[key] : 0;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const approvalCheck = (value: Record<string, unknown>): DiagnosticCheck => {
  const displayed = numericField(value, 'displayed');
  const orphaned = numericField(value, 'orphaned');
  const pending = numericField(value, 'pending');
  let state: CheckState = 'pass';
  if (displayed > 1) {
    state = 'fail';
  } else if (orphaned > 0) {
    state = 'warn';
  }
  return check('approvals', state, `${String(pending)} pending, ${String(orphaned)} orphaned`);
};

const outageCheck = (value: unknown): DiagnosticCheck => {
  const outage = isObject(value) ? value : {};
  const open = Array.isArray(outage['open'])
    ? outage['open'].filter((kind): kind is string => typeof kind === 'string')
    : [];
  return check(
    'outages',
    open.length === 0 ? 'pass' : 'fail',
    open.length === 0 ? 'none open' : open.join(', '),
  );
};

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

const durableAccountCheck = async (
  paths: SpikePaths,
  codex: Record<string, unknown> | null,
): Promise<DiagnosticCheck> => {
  const provider = codex?.['model_provider'];
  if (typeof provider === 'string' && provider !== '' && provider !== 'openai') {
    return check('accounts', 'pass', `custom provider: ${provider}`);
  }
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

const messagesAutomationCheck = async (commands: OperatorCommandPort): Promise<DiagnosticCheck> => {
  const automation = await Effect.runPromise(Effect.result(commands.messagesAutomation));
  if (Result.isFailure(automation)) {
    return check('Messages Automation', 'fail', automation.failure.message);
  }
  const result = automation.success;
  if (result.timedOut) {
    return check('Messages Automation', 'fail', 'command timed out');
  }
  return check(
    'Messages Automation',
    result.exitCode === 0 ? 'pass' : 'fail',
    result.exitCode === 0 ? result.stdout.trim() || 'allowed' : result.stderr.trim() || 'denied',
  );
};

const messagesChecks = async (
  app: SpikeConfig | null,
  commands: OperatorCommandPort,
): Promise<readonly DiagnosticCheck[]> => {
  if (app === null) {
    return [
      check('chat.db FDA', 'fail', 'unconfigured'),
      check('configured conversation', 'fail', 'unconfigured'),
    ];
  }
  const checks: DiagnosticCheck[] = [];
  const opened = await Effect.runPromise(
    Effect.result(
      openMessagesInbox({
        chatGuid: app.chatGuid,
        databasePath: app.messagesDatabase,
        handle: app.handle,
      }),
    ),
  );
  if (Result.isSuccess(opened)) {
    opened.success.close();
    checks.push(
      check('chat.db FDA', 'pass', app.messagesDatabase),
      check('configured conversation', 'pass', `${app.handle} / ${app.chatGuid}`),
    );
  } else {
    checks.push(
      check('chat.db FDA', 'fail', opened.failure.message),
      check('configured conversation', 'fail', opened.failure.message),
    );
  }
  checks.push(await messagesAutomationCheck(commands));
  return checks;
};

const launchdCheck = async (
  paths: SpikePaths,
  config: SpikeConfig | null,
  commands: OperatorCommandPort,
): Promise<DiagnosticCheck> => {
  const target = `${guiDomain()}/${launchAgentLabel}`;
  const inspection = commands
    .launchctl(['print', target])
    .pipe(Effect.flatMap((result) => classifyServiceInspection(target, result)));
  const executed = await Effect.runPromise(Effect.result(inspection));
  if (Result.isFailure(executed)) {
    return check('LaunchAgent context', 'fail', executed.failure.message);
  }
  const loaded = executed.success;
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
    loaded.result.stdout.includes(paths.root) &&
    loaded.result.stdout.includes('CODEX_EXECUTABLE') &&
    loaded.result.stdout.includes('PATH =>');
  const valid = loaded.loaded && plistMatches && loadedContextMatches;
  const failureDetail = loaded.loaded
    ? 'missing or stale launchd context'
    : loaded.result.stderr.trim() || 'service is not loaded';
  return check(
    'LaunchAgent context',
    valid ? 'pass' : 'fail',
    valid ? `${launchAgentLabel} loaded with isolated home` : failureDetail,
  );
};

const makeDoctorReport = async (
  paths: SpikePaths,
  controlStatus: unknown,
  helperPath: string,
  commands: OperatorCommandPort = liveOperatorCommands,
): Promise<DoctorReport> => {
  const status = isObject(controlStatus) ? controlStatus : {};
  const config = await loadDiagnosticConfig(paths);
  const [configuration, launchd, durableAccounts, messages, accessibility] = await Promise.all([
    configChecks(config),
    launchdCheck(paths, config.app, commands),
    durableAccountCheck(paths, config.codex),
    messagesChecks(config.app, commands),
    checkAccessibility(helperPath, config.app?.likeAcknowledgements === true, commands),
  ]);
  const journal = journalCheck(paths);
  const appServer = isObject(status['appServer']) ? status['appServer'] : {};
  const account = isObject(status['account']) ? status['account'] : {};
  const approvals = isObject(status['approvals']) ? status['approvals'] : {};
  const liveEligible = typeof account['eligible'] === 'number' ? account['eligible'] : null;
  const accounts =
    liveEligible === null
      ? durableAccounts
      : check('accounts', liveEligible > 0 ? 'pass' : 'fail', `${String(liveEligible)} eligible`);
  const checks = [
    ...configuration,
    check('control socket', status['ok'] === true ? 'pass' : 'fail', paths.socket),
    journal,
    attachmentStagingCheck(paths, status),
    check(
      'app-server',
      appServer['healthy'] === true ? 'pass' : 'fail',
      appServer['healthy'] === true ? 'responsive' : 'unavailable',
    ),
    approvalCheck(approvals),
    outageCheck(status['outages']),
    accounts,
    ...messages,
    ...accessibility,
    launchd,
  ];
  return { checks, healthy: !checks.some((item) => item.state === 'fail'), ok: true };
};

const isDoctorReport = (value: unknown): value is DoctorReport =>
  isObject(value) && value['ok'] === true && Array.isArray(value['checks']);

export { isDoctorReport, makeDoctorReport };
export type { DiagnosticCheck, DoctorReport };
