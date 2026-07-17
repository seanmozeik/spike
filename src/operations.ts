import { Database } from 'bun:sqlite';
import { access, open, readdir } from 'node:fs/promises';
import path from 'node:path';

import { Effect } from 'effect';

import { loadSpikeConfig } from './app-config';
import { ensureRuntimeLayout } from './config-files';
import { requestControl } from './control-socket';
import { guiDomain, launchAgentLabel, runLaunchctl, writeLaunchAgent } from './launchd';
import { spikePaths } from './paths';
import { inspectApprovalList } from './status/approvals';
import { isDoctorReport, makeDoctorReport } from './status/doctor';

const LOG_TAIL_LINES = 200;
const LOG_TAIL_BYTES = 65_536;
const DOCTOR_TIMEOUT_MS = 10_000;
const UNLOAD_POLL_MS = 200;
const UNLOAD_POLLS = 100;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const paths = spikePaths();

const program = (): string => process.argv[1] ?? 'spike';

const lifecycleError = (operation: string, stderr: string): Error =>
  new Error(`${operation} failed: ${stderr.trim() || 'launchctl returned non-zero'}`);

const serviceIsMissing = (stderr: string): boolean =>
  stderr.includes('Could not find service') || stderr.includes('No such process');

const waitUntilUnloaded = async (domain: string, poll = 0): Promise<void> => {
  if (runLaunchctl(['print', `${domain}/${launchAgentLabel}`]).exitCode !== 0) {
    return;
  }
  if (poll >= UNLOAD_POLLS) {
    throw lifecycleError('launchctl bootout', 'service remained loaded after bootout');
  }
  await Bun.sleep(UNLOAD_POLL_MS);
  await waitUntilUnloaded(domain, poll + 1);
};

const unloadService = async (domain: string): Promise<void> => {
  const result = runLaunchctl(['bootout', `${domain}/${launchAgentLabel}`]);
  if (result.exitCode !== 0 && !serviceIsMissing(result.stderr)) {
    throw lifecycleError('launchctl bootout', result.stderr);
  }
  await waitUntilUnloaded(domain);
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const startService = async (): Promise<unknown> => {
  await Effect.runPromise(ensureRuntimeLayout(paths));
  const config = await Effect.runPromise(loadSpikeConfig(paths));
  await writeLaunchAgent({
    bun: process.execPath,
    codex: config.codexExecutable,
    codexHome: config.codexHome,
    path: process.env['PATH'] ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    paths,
    program: program(),
  });
  const domain = guiDomain();
  await unloadService(domain);
  const bootstrap = runLaunchctl(['bootstrap', domain, paths.launchAgent]);
  if (bootstrap.exitCode !== 0) {
    throw lifecycleError('launchctl bootstrap', bootstrap.stderr);
  }
  const kickstart = runLaunchctl(['kickstart', '-k', `${domain}/${launchAgentLabel}`]);
  if (kickstart.exitCode !== 0) {
    throw lifecycleError('launchctl kickstart', kickstart.stderr);
  }
  return { label: launchAgentLabel, ok: true, socket: paths.socket, status: 'started' };
};

const stopService = async (): Promise<unknown> => {
  await unloadService(guiDomain());
  return { label: launchAgentLabel, ok: true, status: 'stopped' };
};

const restartService = async (): Promise<unknown> => {
  await stopService();
  return startService();
};

const serviceStatus = async (): Promise<unknown> => {
  try {
    return await requestControl(paths.socket, { kind: 'status' });
  } catch {
    const launchd = runLaunchctl(['print', `${guiDomain()}/${launchAgentLabel}`]);
    return {
      loaded: launchd.exitCode === 0,
      ok: true,
      running: false,
      service: 'spike',
      socket: paths.socket,
    };
  }
};

const doctor = async (): ReturnType<typeof makeDoctorReport> => {
  try {
    const report = await requestControl(
      paths.socket,
      { kind: 'doctor' },
      { timeoutMs: DOCTOR_TIMEOUT_MS },
    );
    if (isDoctorReport(report)) {
      return report;
    }
  } catch {
    // Fall through to the offline report when the daemon is absent.
  }
  const helper = path.join(path.dirname(program()), 'spike-like');
  return makeDoctorReport(paths, { ok: false }, helper);
};

const approvals = async (): Promise<unknown> => {
  try {
    return await requestControl(paths.socket, { kind: 'approvals' });
  } catch {
    return (await exists(paths.database))
      ? inspectApprovalList(paths.database)
      : { approvals: [], ok: true };
  }
};

const readLogs = async (): Promise<unknown> => {
  try {
    const handle = await open(paths.daemonLog, 'r');
    let contents = '';
    try {
      const stats = await handle.stat();
      const { size } = stats;
      const length = Math.min(size, LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, size - length));
      contents = buffer.toString('utf8');
    } finally {
      await handle.close();
    }
    const lines = contents.trimEnd().split('\n');
    return { ok: true, path: paths.daemonLog, text: lines.slice(-LOG_TAIL_LINES).join('\n') };
  } catch {
    return { ok: true, path: paths.daemonLog, text: '' };
  }
};

const accounts = async (): Promise<unknown> => {
  const entries = await readdir(paths.accounts, { withFileTypes: true }).catch(() => []);
  const configured = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        eligible: await exists(path.join(paths.accounts, entry.name, 'auth.json')),
        id: entry.name,
      })),
  );
  let observations: readonly Record<string, unknown>[] = [];
  if (await exists(paths.database)) {
    const database = new Database(paths.database, { readonly: true, strict: true });
    try {
      observations = database
        .query<Record<string, unknown>, []>(
          `SELECT account_id AS accountId, observed_at AS observedAt, usable,
                  usage_json AS usage, reset_at AS resetAt
           FROM account_observations
           WHERE id IN (SELECT MAX(id) FROM account_observations GROUP BY account_id)
           ORDER BY account_id`,
        )
        .all();
    } finally {
      database.close();
    }
  }
  const status = await serviceStatus();
  const account = isObject(status) && isObject(status['account']) ? status['account'] : {};
  const active = typeof account['active'] === 'string' ? account['active'] : null;
  return { accounts: configured, active: active ?? null, observations, ok: true };
};

export {
  accounts,
  approvals,
  doctor,
  readLogs,
  restartService,
  serviceStatus,
  startService,
  stopService,
};
