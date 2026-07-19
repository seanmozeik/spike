import type { Database } from 'bun:sqlite';
import { readdir } from 'node:fs/promises';
import { loadavg, freemem, totalmem, uptime } from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';

import { loadSpikeConfig } from '../app-config';
import type { CodexRuntime } from '../codex/runtime';
import { readAttachmentStagingDiagnostic } from '../journal/attachment-diagnostic';
import type { SpikePaths } from '../paths';
import type { EngineEventLoopDiagnostics } from '../service/event-loop-diagnostics';
import { spikeVersion } from '../version';
import type { StatusSnapshot } from './model';
import { readOpenOutageKinds } from './outages';
import { readRateLimits } from './rate-limits';
import { readScheduleStatus } from './schedule-status';
import { isStatusSnapshotShape } from './snapshot-guard';

interface SchedulerStatusRow {
  readonly active_logical_turn_id: string | null;
  readonly thread_created_at: string | null;
}

interface LikeStatusRow {
  readonly available: number;
  readonly degraded: number;
  readonly last_failure_at: string | null;
  readonly last_failure_reason: string | null;
  readonly last_success_at: string | null;
}

const PERCENT = 100;
const SECONDS_TO_MILLISECONDS = 1000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readString = (value: unknown, key: string, fallback: string): string => {
  if (!isObject(value)) {
    return fallback;
  }
  const field = value[key];
  return typeof field === 'string' ? field : fallback;
};

const parseMemoryPressure = (output: string): number | null => {
  const match = /System-wide memory free percentage:\s*(?<free>\d+)%/u.exec(output);
  const free = Number(match?.groups?.['free']);
  return Number.isFinite(free) ? PERCENT - free : null;
};

const memoryPressure = (): number => {
  const fallback = ((totalmem() - freemem()) / totalmem()) * PERCENT;
  const result = Bun.spawnSync(['/usr/bin/memory_pressure', '-Q'], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const parsed = result.exitCode === 0 ? parseMemoryPressure(result.stdout.toString()) : null;
  return Number((parsed ?? fallback).toFixed(1));
};

const scalarString = (database: Database, sql: string): string | null =>
  database.query<{ value: string | null }, []>(sql).get()?.value ?? null;

const scalarNumber = (database: Database, sql: string): number =>
  database.query<{ value: number }, []>(sql).get()?.value ?? 0;

const accountCounts = async (
  paths: SpikePaths,
): Promise<{ readonly configured: number; readonly eligible: number }> => {
  try {
    const entries = await readdir(paths.accounts, { withFileTypes: true });
    const candidates = entries.filter((entry) => entry.isDirectory());
    const eligibility = await Promise.all(
      candidates.map((entry) => Bun.file(`${paths.accounts}/${entry.name}/auth.json`).exists()),
    );
    const eligible = eligibility.filter(Boolean).length;
    return { configured: candidates.length, eligible };
  } catch {
    return { configured: 0, eligible: 0 };
  }
};

const configStatus = async (paths: SpikePaths): Promise<StatusSnapshot['config']> => {
  try {
    const app = await Effect.runPromise(loadSpikeConfig(paths));
    const config = Bun.TOML.parse(await Bun.file(path.join(app.codexHome, 'config.toml')).text());
    return {
      fast: readString(config, 'service_tier', 'fast') === 'fast',
      model: readString(config, 'model', 'unknown'),
      reasoning: readString(config, 'model_reasoning_effort', 'unknown'),
      verbosity: readString(config, 'model_verbosity', 'unknown'),
    };
  } catch {
    return { fast: false, model: 'unknown', reasoning: 'unknown', verbosity: 'unknown' };
  }
};

const readLiveCodex = async (
  runtime: CodexRuntime | null,
): Promise<{
  readonly healthy: boolean;
  readonly rateLimits: unknown;
  readonly usage: unknown;
}> => {
  if (runtime === null) {
    return { healthy: false, rateLimits: null, usage: null };
  }
  const [health, rateLimits] = await Promise.allSettled([
    Effect.runPromise(runtime.health),
    Effect.runPromise(runtime.rateLimits),
  ]);
  if (health.status === 'rejected') {
    return { healthy: false, rateLimits: null, usage: null };
  }
  const usage = rateLimits.status === 'fulfilled' ? rateLimits.value : null;
  return { healthy: true, rateLimits: usage, usage };
};

const readApprovals = (database: Database): StatusSnapshot['approvals'] => {
  const row = database
    .query<{ displayed: number; orphaned: number; pending: number; recently_resolved: number }, []>(
      `SELECT
         SUM(CASE WHEN state = 'Pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN state = 'Pending' AND delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS displayed,
         SUM(CASE WHEN state = 'Orphaned' THEN 1 ELSE 0 END) AS orphaned,
         SUM(CASE WHEN state != 'Pending' AND resolved_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS recently_resolved
       FROM approval_requests`,
    )
    .get();
  return {
    displayed: row?.displayed ?? 0,
    orphaned: row?.orphaned ?? 0,
    pending: row?.pending ?? 0,
    recentlyResolved: row?.recently_resolved ?? 0,
  };
};

const readDatabaseStatus = (
  database: Database,
): {
  readonly approvals: StatusSnapshot['approvals'];
  readonly attachment: ReturnType<typeof readAttachmentStagingDiagnostic>;
  readonly like: LikeStatusRow | null;
  readonly outages: NonNullable<StatusSnapshot['outages']>;
  readonly scheduler: SchedulerStatusRow | null;
  readonly schedules: NonNullable<StatusSnapshot['schedules']>;
} => ({
  approvals: readApprovals(database),
  attachment: readAttachmentStagingDiagnostic(database),
  like:
    database
      .query<LikeStatusRow, []>(
        `SELECT available, degraded, last_failure_at, last_failure_reason, last_success_at
         FROM like_status WHERE singleton = 1`,
      )
      .get() ?? null,
  outages: { open: readOpenOutageKinds(database) },
  scheduler:
    database
      .query<SchedulerStatusRow, []>(
        `SELECT s.active_logical_turn_id, g.created_at AS thread_created_at
         FROM scheduler_state s
         JOIN generations g ON g.id = s.generation_id
         WHERE s.singleton = 1`,
      )
      .get() ?? null,
  schedules: readScheduleStatus(database),
});

const turnStatus = (
  database: Database,
  scheduler: SchedulerStatusRow | null,
): StatusSnapshot['turn'] => {
  const threadCreatedAt = scheduler?.thread_created_at;
  const activeTurnId = scheduler?.active_logical_turn_id ?? null;
  const threadAgeSeconds =
    threadCreatedAt === null || threadCreatedAt === undefined
      ? null
      : Math.max(
          0,
          Math.floor((Date.now() - Date.parse(threadCreatedAt)) / SECONDS_TO_MILLISECONDS),
        );
  return {
    lastFinalAt: scalarString(
      database,
      `SELECT MAX(delivered_at) AS value FROM outbound_messages
           WHERE message_kind = 'Final' AND source_kind = 'CodexAgentItem'`,
    ),
    lastWorkAcknowledgementAt: scalarString(
      database,
      "SELECT MAX(delivered_at) AS value FROM outbound_messages WHERE message_kind = 'WorkAck'",
    ),
    pooledMessages: scalarNumber(database, 'SELECT COUNT(*) AS value FROM scheduler_pool_messages'),
    state: activeTurnId === null ? 'idle' : 'running',
    threadAgeSeconds,
  };
};

const eventLoopStatus = (
  eventLoop: EngineEventLoopDiagnostics | null,
): Pick<StatusSnapshot, 'eventLoop'> => (eventLoop === null ? {} : { eventLoop });

const systemStatus = (): StatusSnapshot['system'] => ({
  cpuLoad: Number((loadavg()[0] ?? 0).toFixed(2)),
  memoryPressurePercent: memoryPressure(),
  uptimeSeconds: Math.floor(uptime()),
});

const makeStatusSnapshot = async (
  database: Database,
  paths: SpikePaths,
  startedAt: string,
  runtime: CodexRuntime | null,
  eventLoop: EngineEventLoopDiagnostics | null = null,
): Promise<StatusSnapshot> => {
  const [counts, config, live] = await Promise.all([
    accountCounts(paths),
    configStatus(paths),
    readLiveCodex(runtime),
  ]);
  const { approvals, attachment, like, outages, scheduler, schedules } =
    readDatabaseStatus(database);
  const limits = readRateLimits(live.rateLimits);
  const providerActive = runtime?.accountId.startsWith('provider:') === true;
  const effectiveCounts = providerActive ? { configured: 1, eligible: 1 } : counts;
  return {
    account: {
      active: runtime?.accountId ?? null,
      availability: effectiveCounts.eligible > 0 ? 'available' : 'unavailable',
      ...effectiveCounts,
    },
    appServer: { healthy: live.healthy },
    approvals,
    attachments: {
      available: attachment === null,
      blockedSince: attachment?.blockedSince ?? null,
      diagnostic: attachment?.diagnostic ?? null,
    },
    codex: { ...limits, rawUsage: live.usage },
    config,
    ...eventLoopStatus(eventLoop),
    like: {
      available: like?.available === 1,
      degraded: like?.degraded === 1,
      lastFailureAt: like?.last_failure_at ?? null,
      lastFailureReason: like?.last_failure_reason ?? null,
      lastSuccessAt: like?.last_success_at ?? null,
    },
    ok: true,
    outages,
    schedules,
    service: { healthy: true, pid: process.pid, startedAt, version: spikeVersion },
    system: systemStatus(),
    turn: turnStatus(database, scheduler),
  };
};

const isStatusSnapshot = (value: unknown): value is StatusSnapshot => isStatusSnapshotShape(value);

export { isStatusSnapshot, makeStatusSnapshot, parseMemoryPressure };
export type { StatusSnapshot } from './model';
