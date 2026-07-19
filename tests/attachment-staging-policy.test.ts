import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { AttachmentStagingPermissionError } from '../src/attachments/errors';
import { makeAttachmentStagingPolicy } from '../src/attachments/staging-policy';
import { openJournal } from '../src/database';
import {
  ATTACHMENT_STAGING_DIAGNOSTIC,
  ATTACHMENT_STAGING_EPISODE_KIND,
  makeAttachmentDiagnostic,
} from '../src/journal/attachment-diagnostic';

it.effect('latches permission episodes, backs off repeat polls, and recovers exactly', () =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'spike-attachment-policy-'))),
    (root) =>
      Effect.acquireUseRelease(
        openJournal(path.join(root, 'spike.db')),
        (handle) =>
          Effect.gen(function* attachmentPermissionEpisode() {
            const startedAt = new Date('2026-07-19T10:00:00.000Z');
            let attempts = 0;
            let denied = true;
            const stage = Effect.suspend(() => {
              attempts += 1;
              return denied
                ? Effect.fail(
                    new AttachmentStagingPermissionError({
                      message: 'private fixture path must never be persisted',
                    }),
                  )
                : Effect.succeed(0);
            });
            const diagnostic = makeAttachmentDiagnostic(handle.database);
            const policy = makeAttachmentStagingPolicy({
              diagnostic,
              retryIntervalMs: 1000,
              stage,
            });
            const at = (offset: number): Date => new Date(startedAt.getTime() + offset);

            expect(yield* policy.stageIfDue(startedAt)).toBe(false);
            expect(yield* policy.stageIfDue(at(500))).toBe(false);
            expect(yield* policy.stageIfDue(at(999))).toBe(false);
            expect(attempts).toBe(1);
            expect(yield* policy.stageIfDue(at(1000))).toBe(false);
            expect(attempts).toBe(2);
            expect(
              handle.database
                .query<{ count: number }, []>(
                  "SELECT COUNT(*) AS count FROM failures WHERE operation = 'attachment-staging'",
                )
                .get()?.count,
            ).toBe(1);
            expect(
              handle.database
                .query<{ details_json: null | string; message: string }, []>(
                  "SELECT details_json, message FROM failures WHERE operation = 'attachment-staging'",
                )
                .get(),
            ).toStrictEqual({ details_json: null, message: ATTACHMENT_STAGING_DIAGNOSTIC });

            denied = false;
            expect(yield* policy.stageIfDue(at(1500))).toBe(false);
            expect(attempts).toBe(2);
            expect(yield* policy.stageIfDue(at(2000))).toBe(true);
            expect(attempts).toBe(3);
            expect(
              handle.database
                .query<{ state: string }, [string]>(
                  'SELECT state FROM outage_episodes WHERE kind = ? ORDER BY opened_at DESC LIMIT 1',
                )
                .get(ATTACHMENT_STAGING_EPISODE_KIND)?.state,
            ).toBe('Resolved');

            denied = true;
            expect(yield* policy.stageIfDue(at(2001))).toBe(false);
            const restarted = makeAttachmentStagingPolicy({
              diagnostic,
              retryIntervalMs: 1000,
              stage,
            });
            expect(yield* restarted.stageIfDue(at(2002))).toBe(false);
            expect(attempts).toBe(5);
            expect(
              handle.database
                .query<{ count: number }, []>(
                  "SELECT COUNT(*) AS count FROM failures WHERE operation = 'attachment-staging'",
                )
                .get()?.count,
            ).toBe(2);
          }),
        (handle) => Effect.sync(handle.close),
      ),
    (root) =>
      Effect.sync(() => {
        rmSync(root, { force: true, recursive: true });
      }),
  ),
);
