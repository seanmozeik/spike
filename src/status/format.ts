import type { DoctorReport } from './doctor';
import type { RateLimitWindow } from './rate-limits';
import type { StatusSnapshot } from './snapshot';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
const MILLISECONDS_PER_SECOND = 1000;

const duration = (seconds: number | null): string => {
  if (seconds === null) {
    return '—';
  }
  if (seconds < SECONDS_PER_MINUTE) {
    return `${String(seconds)}s`;
  }
  if (seconds < SECONDS_PER_HOUR) {
    return `${String(Math.floor(seconds / SECONDS_PER_MINUTE))}m`;
  }
  if (seconds < SECONDS_PER_DAY) {
    return `${String(Math.floor(seconds / SECONDS_PER_HOUR))}h`;
  }
  return `${String(Math.floor(seconds / SECONDS_PER_DAY))}d`;
};

const relativeTime = (iso: string | null, now = Date.now()): string => {
  if (iso === null) {
    return '—';
  }
  const difference = Math.floor((now - Date.parse(iso)) / MILLISECONDS_PER_SECOND);
  return difference < 0 ? `in ${duration(Math.abs(difference))}` : `${duration(difference)} ago`;
};

const limit = (window: RateLimitWindow | null): string => {
  if (window === null) {
    return '—';
  }
  const reset = window.resetsAt === null ? 'unknown' : relativeTime(window.resetsAt);
  return `${String(window.remainingPercent)}% left, reset ${reset}`;
};

const formatStatus = (status: StatusSnapshot): string => {
  const like = status.like.available
    ? 'Like ready'
    : `Like degraded${status.like.lastFailureReason === null ? '' : ` (${status.like.lastFailureReason})`}`;
  const openOutages = status.outages?.open ?? [];
  const lines = [
    `Spike up · app-server ${status.appServer.healthy ? 'up' : 'down'} · ${status.service.version}`,
    `${status.config.model} · ${status.config.reasoning} · ${status.config.verbosity} · Fast ${status.config.fast ? 'on' : 'off'}`,
    `Account ${status.account.active ?? '—'} · ${String(status.account.eligible)}/${String(status.account.configured)} eligible · ${status.account.availability}`,
    `5h ${limit(status.codex.fiveHour)} · weekly ${limit(status.codex.weekly)}`,
    `Turn ${status.turn.state} · pooled ${String(status.turn.pooledMessages)} · thread ${duration(status.turn.threadAgeSeconds)}`,
    `Approvals ${String(status.approvals.pending)} pending · ${String(status.approvals.displayed)} displayed · ${String(status.approvals.orphaned)} orphaned`,
    `Outages ${openOutages.length === 0 ? 'none' : openOutages.join(', ')}`,
    `Ack ${relativeTime(status.turn.lastWorkAcknowledgementAt)} · final ${relativeTime(status.turn.lastFinalAt)}`,
    `Mac ${duration(status.system.uptimeSeconds)} up · load ${String(status.system.cpuLoad)} · pressure ${String(status.system.memoryPressurePercent)}% · ${like}`,
  ];
  const { attachments } = status;
  if (attachments !== undefined && !attachments.available && attachments.diagnostic !== null) {
    lines.push(attachments.diagnostic);
  }
  const loop = status.eventLoop;
  if (loop !== undefined) {
    lines.push(
      `Messages event loop · ${String(loop.filesystem.wakes)} wakes · ${String(loop.messages.queries)} queries · ${String(loop.reconciliation.failures)} reconcile failures`,
    );
  }
  return lines.join('\n');
};

const checkMarker = (state: 'fail' | 'pass' | 'warn'): string => {
  if (state === 'pass') {
    return '✓';
  }
  return state === 'warn' ? '~' : '✗';
};

const formatDoctor = (report: DoctorReport): string =>
  [
    `Spike doctor: ${report.healthy ? 'healthy' : 'needs attention'}`,
    ...report.checks.map((item) => `${checkMarker(item.state)} ${item.name}: ${item.detail}`),
  ].join('\n');

export { duration, formatDoctor, formatStatus, relativeTime };
