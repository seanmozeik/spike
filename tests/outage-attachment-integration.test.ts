import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { openJournal } from '../src/database';
import {
  ATTACHMENT_STAGING_DIAGNOSTIC,
  ATTACHMENT_STAGING_EPISODE_KIND,
  makeAttachmentDiagnostic,
} from '../src/journal/attachment-diagnostic';
import type { OperatorCommandPort } from '../src/operator/commands';
import { makeOutageJournal } from '../src/outage/journal';
import { makeOutageService } from '../src/outage/service';
import { spikePaths } from '../src/paths';
import { makeDoctorReport } from '../src/status/doctor';
import { formatStatus } from '../src/status/format';
import { makeStatusSnapshot } from '../src/status/snapshot';

const roots: string[] = [];

const missingService = {
  exitCode: 3,
  signalCode: null,
  stderr: 'Could not find service',
  stdout: '',
  timedOut: false,
} as const;

const commands: OperatorCommandPort = {
  accessibilityStatus: () => Effect.succeed(missingService),
  launchctl: () => Effect.succeed(missingService),
  messagesAutomation: Effect.succeed(missingService),
};

const occurrences = (text: string, value: string): number => text.split(value).length - 1;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('keeps attachment diagnostics separate from Codex outage recovery and reporting', () =>
  Effect.gen(function* crossFeatureOutageFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-outage-attachment-'));
    roots.push(root);
    const paths = spikePaths(root);
    mkdirSync(path.dirname(paths.database), { recursive: true });
    const handle = yield* openJournal(paths.database);
    const openedAt = new Date('2026-07-19T12:00:00.000Z');
    yield* makeAttachmentDiagnostic(handle.database).open(openedAt);
    const outages = makeOutageService(makeOutageJournal(handle.database), {
      deliver: () => Effect.void,
    });
    yield* outages.authenticationUnavailable(openedAt);

    const status = yield* Effect.promise(() =>
      makeStatusSnapshot(handle.database, paths, openedAt.toISOString(), null),
    );
    expect(status.outages?.open).toStrictEqual(['CodexAuthentication']);
    expect(status.attachments).toStrictEqual({
      available: false,
      blockedSince: openedAt.toISOString(),
      diagnostic: ATTACHMENT_STAGING_DIAGNOSTIC,
    });
    const formatted = formatStatus(status);
    expect(occurrences(formatted, 'CodexAuthentication')).toBe(1);
    expect(occurrences(formatted, ATTACHMENT_STAGING_DIAGNOSTIC)).toBe(1);
    expect(formatted).not.toContain(ATTACHMENT_STAGING_EPISODE_KIND);
    expect(formatted).not.toContain(root);
    expect(formatted).not.toContain('could not use any configured Codex account');

    const doctor = yield* Effect.promise(() =>
      makeDoctorReport(paths, status, path.join(root, 'spike-like'), commands),
    );
    const signals = doctor.checks.filter(
      ({ name }) => name === 'attachment staging' || name === 'outages',
    );
    expect(signals).toStrictEqual([
      { detail: ATTACHMENT_STAGING_DIAGNOSTIC, name: 'attachment staging', state: 'fail' },
      { detail: 'CodexAuthentication', name: 'outages', state: 'fail' },
    ]);
    const serializedSignals = JSON.stringify(signals);
    expect(serializedSignals).not.toContain(ATTACHMENT_STAGING_EPISODE_KIND);
    expect(serializedSignals).not.toContain(root);
    expect(serializedSignals).not.toContain('could not use any configured Codex account');

    const recoveryAt = new Date(openedAt.getTime() + 1);
    const resolved = yield* outages.recovered(recoveryAt);
    expect(resolved).toBe(1);
    expect(
      handle.database
        .query<{ kind: string }, []>(
          "SELECT kind FROM outage_episodes WHERE state = 'Open' ORDER BY kind",
        )
        .all(),
    ).toStrictEqual([{ kind: ATTACHMENT_STAGING_EPISODE_KIND }]);
    const recovered = yield* Effect.promise(() =>
      makeStatusSnapshot(handle.database, paths, openedAt.toISOString(), null),
    );
    expect(recovered.outages?.open).toStrictEqual([]);
    expect(recovered.attachments?.available).toBe(false);
    handle.close();
  }),
);
