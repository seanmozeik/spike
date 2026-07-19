import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect } from 'vitest';

import { openJournal } from '../src/database';
import { spikePaths } from '../src/paths';
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
});
