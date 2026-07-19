import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect } from 'vitest';

import { openJournal } from '../src/database';
import {
  ATTACHMENT_STAGING_DIAGNOSTIC,
  makeAttachmentDiagnostic,
} from '../src/journal/attachment-diagnostic';
import { spikePaths } from '../src/paths';
import type { EngineEventLoopDiagnostics } from '../src/service/event-loop-diagnostics';
import { duration, formatStatus, relativeTime } from '../src/status/format';
import { readRateLimits } from '../src/status/rate-limits';
import {
  isStatusSnapshot,
  makeStatusSnapshot,
  parseMemoryPressure,
  type StatusSnapshot,
} from '../src/status/snapshot';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const snapshot = (): StatusSnapshot => ({
  account: { active: 'default', availability: 'available', configured: 1, eligible: 1 },
  appServer: { healthy: true },
  approvals: { displayed: 1, orphaned: 0, pending: 2, recentlyResolved: 3 },
  attachments: { available: true, blockedSince: null, diagnostic: null },
  codex: {
    fiveHour: { remainingPercent: 80, resetsAt: '2026-07-14T22:00:00.000Z' },
    rawUsage: null,
    weekly: { remainingPercent: 65, resetsAt: '2026-07-20T00:00:00.000Z' },
  },
  config: { fast: true, model: 'example-model', reasoning: 'medium', verbosity: 'low' },
  like: {
    available: false,
    degraded: true,
    lastFailureAt: '2026-07-14T19:00:00.000Z',
    lastFailureReason: 'locked',
    lastSuccessAt: null,
  },
  ok: true,
  outages: { open: [] },
  service: { healthy: true, pid: 123, startedAt: '2026-07-14T18:00:00.000Z', version: '0.0.1' },
  system: { cpuLoad: 1.25, memoryPressurePercent: 42.5, uptimeSeconds: 7200 },
  turn: {
    lastFinalAt: '2026-07-14T19:59:00.000Z',
    lastWorkAcknowledgementAt: '2026-07-14T19:58:00.000Z',
    pooledMessages: 2,
    state: 'running',
    threadAgeSeconds: 3600,
  },
});

const staleSnapshot = (): unknown => {
  const stale: Record<string, unknown> = { ...snapshot() };
  delete stale['attachments'];
  return stale;
};

const eventLoopDiagnostics = (): EngineEventLoopDiagnostics => ({
  filesystem: {
    events: 12,
    lastEventAt: '2026-07-19T12:00:00.000Z',
    lastWakeAt: '2026-07-19T12:00:00.005Z',
    wakes: 4,
  },
  messages: {
    lastPassAt: '2026-07-19T12:00:00.006Z',
    lastQueryAt: '2026-07-19T12:00:00.006Z',
    passes: 5,
    queries: 5,
  },
  reconciliation: {
    failures: 0,
    lastAt: '2026-07-19T11:59:00.000Z',
    lastFailureAt: null,
    passes: 2,
  },
  startedAt: '2026-07-19T10:00:00.000Z',
  watcher: {
    active: true,
    activeFileWatchers: 3,
    closed: false,
    failures: 0,
    lastFailureAt: null,
    restartScheduled: false,
    restarts: 0,
  },
});

describe('compact status', () => {
  it('normalizes the current five-hour and weekly rate-limit response', () => {
    expect(
      readRateLimits({
        rateLimits: {
          primary: { resetsAt: 1_777_777_777, usedPercent: 20, windowDurationMins: 300 },
          secondary: null,
        },
        rateLimitsByLimitId: {
          'codex:gpt-5': {
            primary: null,
            secondary: { resetsAt: 1_777_778_000_000, usedPercent: 35, windowDurationMins: 10_080 },
          },
        },
      }),
    ).toStrictEqual({
      fiveHour: { remainingPercent: 80, resetsAt: '2026-05-03T03:09:37.000Z' },
      weekly: { remainingPercent: 65, resetsAt: '2026-05-03T03:13:20.000Z' },
    });
  });

  it('does not mislabel a weekly primary window as five-hour usage', () => {
    expect(
      readRateLimits({
        rateLimits: {
          primary: { resetsAt: 1_784_638_721, usedPercent: 13, windowDurationMins: 10_080 },
          secondary: null,
        },
      }),
    ).toStrictEqual({
      fiveHour: null,
      weekly: { remainingPercent: 87, resetsAt: '2026-07-21T12:58:41.000Z' },
    });
  });

  it('renders one compact bubble with every operator signal', () => {
    const output = formatStatus(snapshot());
    expect(output.split('\n')).toHaveLength(9);
    expect(output).toContain('example-model · medium · low · Fast on');
    expect(output).toContain('5h 80% left');
    expect(output).toContain('weekly 65% left');
    expect(output).toContain('Turn running · pooled 2 · thread 1h');
    expect(output).toContain('Approvals 2 pending · 1 displayed · 0 orphaned');
    expect(output).toContain('Outages none');
    expect(output).toContain('pressure 42.5% · Like degraded (locked)');
  });

  it('renders a complete pre-outage daemon snapshot during a rolling upgrade', () => {
    const { outages: _outages, ...legacySnapshot } = snapshot();

    expect(isStatusSnapshot(legacySnapshot)).toBe(true);
    if (!isStatusSnapshot(legacySnapshot)) {
      return;
    }

    expect(formatStatus(legacySnapshot)).toContain('Outages none');
  });

  it('rejects malformed outage data before compact formatting', () => {
    expect(isStatusSnapshot({ ...snapshot(), outages: { open: 'CodexAuthentication' } })).toBe(
      false,
    );
  });

  it('adds one bounded actionable line only while attachment staging is blocked', () => {
    const output = formatStatus({
      ...snapshot(),
      attachments: {
        available: false,
        blockedSince: '2026-07-19T10:00:00.000Z',
        diagnostic: ATTACHMENT_STAGING_DIAGNOSTIC,
      },
    });
    expect(output.split('\n')).toHaveLength(10);
    expect(output).toContain(ATTACHMENT_STAGING_DIAGNOSTIC);
  });

  it('formats a pre-v15 daemon snapshot without the attachment field', () => {
    const stale = staleSnapshot();
    expect(isStatusSnapshot(stale)).toBe(true);
    if (!isStatusSnapshot(stale)) {
      throw new Error('expected the stale daemon response to remain compatible');
    }
    expect(formatStatus(stale).split('\n')).toHaveLength(9);
  });

  it('rejects malformed attachment data before compact formatting', () => {
    expect(isStatusSnapshot({ ...snapshot(), attachments: null })).toBe(false);
  });

  it('formats and validates redacted event-loop soak diagnostics', () => {
    const current = { ...snapshot(), eventLoop: eventLoopDiagnostics() };
    expect(isStatusSnapshot(current)).toBe(true);
    const output = formatStatus(current);
    expect(output).toContain('Messages event loop · 4 wakes · 5 queries · 0 reconcile failures');
    const serialized = JSON.stringify(current.eventLoop);
    expect(serialized).not.toContain('chat.db');
    expect(serialized).not.toContain('/Users/');
    expect(
      isStatusSnapshot({
        ...current,
        eventLoop: { ...current.eventLoop, messages: { passes: 1, queries: 'twice' } },
      }),
    ).toBe(false);
  });

  it('formats past and future operator times without losing reset direction', () => {
    const now = Date.parse('2026-07-14T20:00:00.000Z');
    expect(relativeTime('2026-07-14T19:59:00.000Z', now)).toBe('1m ago');
    expect(relativeTime('2026-07-14T22:00:00.000Z', now)).toBe('in 2h');
    expect(duration(null)).toBe('—');
  });

  it('parses the macOS memory pressure query', () => {
    expect(parseMemoryPressure('System-wide memory free percentage: 90%')).toBe(10);
    expect(parseMemoryPressure('unavailable')).toBeNull();
  });

  it.effect('counts only delivered Codex agent finals as conversation activity', () =>
    Effect.gen(function* statusFinalRole() {
      const root = mkdtempSync(path.join(tmpdir(), 'spike-status-final-role-'));
      roots.push(root);
      const handle = yield* openJournal(path.join(root, 'spike.db'));
      const createdAt = '2026-07-14T19:00:00.000Z';
      handle.database.run(
        "INSERT INTO generations(id, sequence, state, created_at) VALUES ('generation', 1, 'Current', ?)",
        [createdAt],
      );
      handle.database.run(
        `INSERT INTO logical_turns(
           id, generation_id, sequence, state, correlation_id, created_at
         ) VALUES ('turn', 'generation', 1, 'Completed', 'correlation', ?)`,
        [createdAt],
      );
      handle.database.run(
        `INSERT INTO outbound_messages(
           id, logical_turn_id, source_kind, source_id, message_kind, text, state,
           created_at, delivered_at
         ) VALUES
           ('assistant', 'turn', 'CodexAgentItem', 'final-item', 'Final', 'Answer',
            'Delivered', ?, '2026-07-14T19:01:00.000Z'),
           ('control', NULL, 'Control', 'status:1', 'Final', 'Status',
            'Delivered', ?, '2026-07-14T19:02:00.000Z'),
           ('failure', 'turn', 'TurnFailureNotice', 'turn', 'Final', 'Failure',
            'Delivered', ?, '2026-07-14T19:03:00.000Z')`,
        [createdAt, createdAt, createdAt],
      );

      const status = yield* Effect.promise(() =>
        makeStatusSnapshot(handle.database, spikePaths(root), createdAt, null),
      );

      expect(status.turn.lastFinalAt).toBe('2026-07-14T19:01:00.000Z');
      handle.close();
    }),
  );

  it.effect('reads and clears the durable attachment staging episode', () =>
    Effect.gen(function* attachmentStatus() {
      const root = mkdtempSync(path.join(tmpdir(), 'spike-status-attachment-'));
      roots.push(root);
      const paths = spikePaths(root);
      mkdirSync(path.dirname(paths.database), { recursive: true });
      const handle = yield* openJournal(paths.database);
      const openedAt = new Date('2026-07-19T10:00:00.000Z');
      const diagnostic = makeAttachmentDiagnostic(handle.database);
      yield* diagnostic.open(openedAt);

      const blocked = yield* Effect.promise(() =>
        makeStatusSnapshot(handle.database, paths, openedAt.toISOString(), null),
      );
      expect(blocked.attachments).toStrictEqual({
        available: false,
        blockedSince: openedAt.toISOString(),
        diagnostic: ATTACHMENT_STAGING_DIAGNOSTIC,
      });

      yield* diagnostic.resolve(new Date(openedAt.getTime() + 1));
      const recovered = yield* Effect.promise(() =>
        makeStatusSnapshot(handle.database, paths, openedAt.toISOString(), null),
      );
      expect(recovered.attachments).toStrictEqual({
        available: true,
        blockedSince: null,
        diagnostic: null,
      });
      handle.close();
    }),
  );
});
