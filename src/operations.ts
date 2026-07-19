import { Database } from 'bun:sqlite';
import { access, open, readdir } from 'node:fs/promises';
import path from 'node:path';

import { Effect } from 'effect';

import { loadSpikeConfig } from './app-config';
import { ensureRuntimeLayout } from './config-files';
import { requestControl } from './control-socket';
import { SpikeRuntimeError } from './errors';
import { guiDomain, launchAgentLabel, writeLaunchAgent } from './launchd';
import { liveOperatorCommands } from './operator/commands';
import {
  classifyServiceInspection,
  makeServiceLifecycle,
  type ServiceLifecycleResult,
} from './operator/lifecycle';
import { spikePaths } from './paths';
import { inspectApprovalList, isApprovalList, type ApprovalList } from './status/approvals';
import { isDoctorReport, makeDoctorReport, type DoctorReport } from './status/doctor';
import { isStatusSnapshot, type StatusSnapshot } from './status/snapshot';

const LOG_TAIL_LINES = 200;
const LOG_TAIL_BYTES = 65_536;
const DOCTOR_TIMEOUT_MS = 10_000;

interface OfflineServiceStatus {
  readonly loaded: boolean;
  readonly ok: true;
  readonly running: false;
  readonly service: 'spike';
  readonly socket: string;
}

interface LogResult {
  readonly ok: true;
  readonly path: string;
  readonly text: string;
}

interface AccountResult {
  readonly accounts: readonly { readonly eligible: boolean; readonly id: string }[];
  readonly active: string | null;
  readonly observations: readonly Record<string, unknown>[];
  readonly ok: true;
}

type ServiceStatusResult = OfflineServiceStatus | StatusSnapshot;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const paths = spikePaths();

const program = (): string => process.argv[1] ?? 'spike';

const operatorError = (operation: string, cause: unknown): SpikeRuntimeError =>
  cause instanceof SpikeRuntimeError
    ? cause
    : new SpikeRuntimeError({
        cause,
        message: cause instanceof Error ? cause.message : String(cause),
        operation,
      });

const prepareService = Effect.gen(function* prepareService() {
  yield* ensureRuntimeLayout(paths);
  const config = yield* loadSpikeConfig(paths);
  yield* Effect.tryPromise({
    catch: (cause) => operatorError('lifecycle/write-launch-agent', cause),
    try: () =>
      writeLaunchAgent({
        bun: process.execPath,
        codex: config.codexExecutable,
        codexHome: config.codexHome,
        path:
          process.env['PATH'] ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        paths,
        program: program(),
      }),
  });
}).pipe(Effect.mapError((cause) => operatorError('lifecycle/prepare', cause)));

const lifecycle = makeServiceLifecycle({
  commands: liveOperatorCommands,
  domain: guiDomain(),
  label: launchAgentLabel,
  launchAgent: paths.launchAgent,
  prepare: prepareService,
  socket: paths.socket,
});

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const startService = (): Promise<ServiceLifecycleResult> => Effect.runPromise(lifecycle.start);

const stopService = (): Promise<ServiceLifecycleResult> => Effect.runPromise(lifecycle.stop);

const restartService = (): Promise<ServiceLifecycleResult> => Effect.runPromise(lifecycle.restart);

const serviceStatus = async (): Promise<ServiceStatusResult> => {
  try {
    const status = await requestControl(paths.socket, { kind: 'status' });
    if (isStatusSnapshot(status)) {
      return status;
    }
  } catch {
    // Fall through to launchd inspection when the daemon is absent.
  }
  const target = `${guiDomain()}/${launchAgentLabel}`;
  const inspect = liveOperatorCommands
    .launchctl(['print', target])
    .pipe(Effect.flatMap((result) => classifyServiceInspection(target, result)));
  const launchd = await Effect.runPromise(inspect);
  return {
    loaded: launchd.loaded,
    ok: true,
    running: false,
    service: 'spike',
    socket: paths.socket,
  };
};

const doctor = async (): Promise<DoctorReport> => {
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
  return makeDoctorReport(paths, { ok: false }, helper, liveOperatorCommands);
};

const approvals = async (): Promise<ApprovalList> => {
  try {
    const response = await requestControl(paths.socket, { kind: 'approvals' });
    if (isApprovalList(response)) {
      return response;
    }
  } catch {
    // Fall through to durable inspection when the daemon is absent.
  }
  return (await exists(paths.database))
    ? inspectApprovalList(paths.database)
    : { approvals: [], ok: true };
};

const readLogs = async (): Promise<LogResult> => {
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

const accounts = async (): Promise<AccountResult> => {
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
export type { AccountResult, LogResult, OfflineServiceStatus, ServiceStatusResult };
