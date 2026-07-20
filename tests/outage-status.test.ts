import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { afterEach, expect } from 'vitest';

import { ensureRuntimeLayout } from '../src/config-files';
import { requestControl } from '../src/control-socket';
import { serveDaemon } from '../src/daemon';
import { openJournal } from '../src/database';
import { makeOutageJournal } from '../src/outage/journal';
import { spikePaths } from '../src/paths';
import { isDoctorReport } from '../src/status/doctor';
import { formatStatus } from '../src/status/format';
import { isStatusSnapshot } from '../src/status/snapshot';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('surfaces open outage kinds in status and doctor without leaking notice text', () =>
  Effect.gen(function* outageStatusFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-outage-status-'));
    roots.push(root);
    const paths = spikePaths(root);
    yield* ensureRuntimeLayout(paths);
    writeFileSync(
      paths.config,
      `chat_guid = "any;-;+15555550199"
handle = "+15555550199"
working_directory = "/tmp"
like_acknowledgements = false
`,
    );
    writeFileSync(paths.codexConfig, 'approval_policy = "never"\n', 'utf8');
    const journal = yield* openJournal(paths.database);
    yield* makeOutageJournal(journal.database).open(
      'CodexAuthentication',
      'private-auth-detail-must-not-escape',
      new Date('2026-07-19T12:00:00.000Z'),
    );
    journal.close();

    const daemon = yield* Effect.forkChild(serveDaemon(paths, { codex: false }));
    for (let attempt = 0; attempt < 50 && !existsSync(paths.socket); attempt += 1) {
      yield* Effect.promise(() => Bun.sleep(10));
    }

    const status = yield* Effect.promise(() => requestControl(paths.socket, { kind: 'status' }));
    const doctor = yield* Effect.promise(() => requestControl(paths.socket, { kind: 'doctor' }));
    expect(status).toMatchObject({ outages: { open: ['CodexAuthentication'] } });
    expect(isStatusSnapshot(status)).toBe(true);
    if (!isStatusSnapshot(status)) {
      return;
    }
    expect(formatStatus(status)).toContain('Outages CodexAuthentication');
    expect(formatStatus(status)).not.toContain('private-auth-detail-must-not-escape');
    expect(isDoctorReport(doctor)).toBe(true);
    if (!isDoctorReport(doctor)) {
      return;
    }
    expect(doctor.healthy).toBe(false);
    expect(doctor.checks).toContainEqual({
      detail: 'CodexAuthentication',
      name: 'outages',
      state: 'fail',
    });
    expect(JSON.stringify({ doctor, status })).not.toContain('private-auth-detail-must-not-escape');

    yield* Effect.promise(() => requestControl(paths.socket, { kind: 'shutdown' }));
    yield* Fiber.join(daemon);
  }),
);
