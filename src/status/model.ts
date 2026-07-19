import type { EngineEventLoopDiagnostics } from '../service/event-loop-diagnostics';
import type { RateLimitWindow } from './rate-limits';

interface StatusSnapshot {
  readonly account: {
    readonly active: string | null;
    readonly availability: 'available' | 'unavailable';
    readonly configured: number;
    readonly eligible: number;
  };
  readonly appServer: { readonly healthy: boolean };
  readonly approvals: {
    readonly displayed: number;
    readonly orphaned: number;
    readonly pending: number;
    readonly recentlyResolved: number;
  };
  /** Missing when talking to a daemon that predates attachment staging diagnostics. */
  readonly attachments?: {
    readonly available: boolean;
    readonly blockedSince: string | null;
    readonly diagnostic: string | null;
  };
  readonly codex: {
    readonly fiveHour: RateLimitWindow | null;
    readonly rawUsage: unknown;
    readonly weekly: RateLimitWindow | null;
  };
  readonly config: {
    readonly fast: boolean;
    readonly model: string;
    readonly reasoning: string;
    readonly verbosity: string;
  };
  /** Missing when talking to a daemon that predates event-driven Messages diagnostics. */
  readonly eventLoop?: EngineEventLoopDiagnostics;
  readonly like: {
    readonly available: boolean;
    readonly degraded: boolean;
    readonly lastFailureAt: string | null;
    readonly lastFailureReason: string | null;
    readonly lastSuccessAt: string | null;
  };
  readonly ok: true;
  /** Missing when talking to a daemon that predates durable Codex outage reporting. */
  readonly outages?: { readonly open: readonly string[] };
  /** Missing when talking to a daemon that predates durable schedules. */
  readonly schedules?: {
    readonly active: number;
    readonly cancelled: number;
    readonly completed: number;
    readonly nextDueAt: string | null;
    readonly paused: number;
    readonly queued: number;
    readonly running: number;
  };
  readonly service: {
    readonly healthy: true;
    readonly pid: number;
    readonly startedAt: string;
    readonly version: string;
  };
  readonly system: {
    readonly cpuLoad: number;
    readonly memoryPressurePercent: number;
    readonly uptimeSeconds: number;
  };
  readonly turn: {
    readonly lastFinalAt: string | null;
    readonly lastWorkAcknowledgementAt: string | null;
    readonly pooledMessages: number;
    readonly state: 'idle' | 'running';
    readonly threadAgeSeconds: number | null;
  };
}

export type { StatusSnapshot };
