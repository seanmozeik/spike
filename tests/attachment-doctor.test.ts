import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { openJournal } from '../src/database';
import {
  ATTACHMENT_STAGING_DIAGNOSTIC,
  makeAttachmentDiagnostic,
} from '../src/journal/attachment-diagnostic';
import { spikePaths } from '../src/paths';
import { attachmentStagingCheck } from '../src/status/attachment-check';

it.effect('reports bounded attachment staging diagnostics live and offline', () =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'spike-attachment-doctor-'))),
    (root) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const paths = spikePaths(root);
          mkdirSync(path.dirname(paths.database), { recursive: true });
          return paths;
        }).pipe(Effect.flatMap((paths) => openJournal(paths.database))),
        (handle) =>
          Effect.gen(function* attachmentDoctor() {
            const paths = spikePaths(root);
            const diagnostic = makeAttachmentDiagnostic(handle.database);
            const openedAt = new Date('2026-07-19T10:00:00.000Z');
            yield* diagnostic.open(openedAt);

            expect(attachmentStagingCheck(paths, {})).toStrictEqual({
              detail: ATTACHMENT_STAGING_DIAGNOSTIC,
              name: 'attachment staging',
              state: 'fail',
            });
            expect(
              attachmentStagingCheck(paths, {
                attachments: {
                  available: false,
                  blockedSince: openedAt.toISOString(),
                  diagnostic: ATTACHMENT_STAGING_DIAGNOSTIC,
                },
              }),
            ).toStrictEqual({
              detail: ATTACHMENT_STAGING_DIAGNOSTIC,
              name: 'attachment staging',
              state: 'fail',
            });

            yield* diagnostic.resolve(new Date(openedAt.getTime() + 1));
            expect(attachmentStagingCheck(paths, {})).toStrictEqual({
              detail: 'available',
              name: 'attachment staging',
              state: 'pass',
            });
          }),
        (handle) => Effect.sync(handle.close),
      ),
    (root) =>
      Effect.sync(() => {
        rmSync(root, { force: true, recursive: true });
      }),
  ),
);
