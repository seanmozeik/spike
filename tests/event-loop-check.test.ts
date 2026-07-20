import { describe, expect, it } from 'vitest';

import { eventLoopCheck } from '../src/status/event-loop-check';

const diagnostics = (polls: number, active: boolean): Record<string, unknown> => ({
  filesystem: { wakes: 0 },
  messages: { passes: polls, polls, queries: polls },
  reconciliation: { failures: 0 },
  watcher: { active, failures: 0 },
});

describe('Messages event-loop health', () => {
  it('passes when bounded polling is live even without watcher wakes', () => {
    expect(eventLoopCheck(diagnostics(20, true))).toStrictEqual({
      detail:
        '20 liveness polls, watching, 0 watcher wakes, 20 queries, 20 passes, 0 reconciliation failures, 0 watcher failures',
      name: 'Messages event loop',
      state: 'pass',
    });
  });

  it('warns when polling is live but the optional watcher is unavailable', () => {
    expect(eventLoopCheck(diagnostics(20, false)).state).toBe('warn');
  });

  it('fails when no bounded poll has completed despite active watcher handles', () => {
    expect(eventLoopCheck(diagnostics(0, true)).state).toBe('fail');
  });
});
