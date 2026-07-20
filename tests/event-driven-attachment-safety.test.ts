import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, vi } from 'vitest';

import type { ObservedMessage } from '../src/domain/inbound';
import { inbound, makeEngineFixture, type EngineFixture } from './engine-fixture';
import { makeWatcherHarness } from './messages-watcher-harness';

const JPEG = Buffer.from('FFD8FFD9', 'hex');
const NOW = '2026-07-19T12:00:00.000Z';

interface SeededAttachment {
  readonly message: ObservedMessage;
  readonly stagedPath: string;
}

const waitFor = (assertion: () => void): Effect.Effect<void> =>
  Effect.promise(() => vi.waitFor(assertion));

const attachmentMessage = (rowId: number, text: string): ObservedMessage => ({
  ...inbound(rowId, text),
  attachments: [
    {
      attachmentGuid: `attachment-${String(rowId)}`,
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      totalBytes: JPEG.byteLength,
      transferName: 'photo.jpg',
      uti: 'public.jpeg',
    },
  ],
});

const seedStagedAttachment = (
  fixture: EngineFixture,
  rowId: number,
  text: string,
): SeededAttachment => {
  const message = attachmentMessage(rowId, text);
  const attachmentGuid = `attachment-${String(rowId)}`;
  const contentHash = createHash('sha256').update(JPEG).digest('hex');
  const stagedPath = path.join(fixture.attachmentStagingRoot, `${contentHash}.jpg`);
  const inboundId = `inbound-${String(rowId)}`;
  mkdirSync(fixture.attachmentStagingRoot, { mode: 0o700, recursive: true });
  writeFileSync(
    path.join(fixture.attachmentStagingRoot, '.spike-attachment-store-v1'),
    'spike-attachment-store-v1\n',
    { mode: 0o600 },
  );
  writeFileSync(stagedPath, JPEG, { mode: 0o600 });
  fixture.database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (?, ?, ?, ?, ?, 'iMessage', ?, ?, ?)`,
    [inboundId, message.messageGuid, rowId, message.chatGuid, message.handle, text, NOW, NOW],
  );
  fixture.database.run(
    `INSERT INTO attachments(
       id, inbound_message_id, attachment_guid, state, mime_type, total_bytes,
       staged_path, content_hash, ordinal, created_at
     ) VALUES (?, ?, ?, 'Staged', 'image/jpeg', ?, ?, ?, 0, ?)`,
    [
      `attachment-row-${String(rowId)}`,
      inboundId,
      attachmentGuid,
      JPEG.byteLength,
      stagedPath,
      contentHash,
      NOW,
    ],
  );
  fixture.push(message);
  return { message, stagedPath };
};

const shutdown = (
  fixture: EngineFixture,
  run: Fiber.Fiber<never, unknown>,
): Effect.Effect<void, unknown> =>
  fixture.engine.shutdown.pipe(
    Effect.andThen(Fiber.interrupt(run)),
    Effect.andThen(Effect.sync(fixture.remove)),
  );

it.effect('audits a Messages-only wake after CAS tampering before ordinary dispatch', () =>
  Effect.gen(function* messagesOnlyAudit() {
    const watcher = makeWatcherHarness();
    const fixture = yield* makeEngineFixture({
      messagesDebounceMs: 5,
      reconcileIntervalMs: 60_000,
      watchMessages: watcher.open,
    });
    const run = yield* Effect.forkChild(fixture.engine.run);
    yield* waitFor(() => {
      expect(fixture.inboxScans).toBeGreaterThan(0);
    });
    yield* Effect.promise(() => Bun.sleep(20));

    const { stagedPath } = seedStagedAttachment(fixture, 1, 'tampered attachment');
    writeFileSync(stagedPath, Buffer.from('00000000', 'hex'));
    watcher.dirty();

    yield* waitFor(() => {
      expect(fixture.inputs).toStrictEqual([
        'tampered attachment\n[Attachment rejected: staged-integrity]',
      ]);
    });
    expect(fixture.attachmentInputs).toStrictEqual([[]]);
    expect(
      fixture.database
        .query<{ state: string }, []>("SELECT state FROM attachments WHERE id = 'attachment-row-1'")
        .get(),
    ).toStrictEqual({ state: 'Failed' });
    yield* shutdown(fixture, run);
  }),
);

it.effect('fails closed on audit outage while trusted controls continue, then retries once', () =>
  Effect.gen(function* auditFailure() {
    const fixture = yield* makeEngineFixture({ phaseRetryMs: 10, reconcileIntervalMs: 10 });
    const run = yield* Effect.forkChild(fixture.engine.run);
    yield* waitFor(() => {
      expect(fixture.inboxScans).toBeGreaterThan(0);
    });

    const { stagedPath } = seedStagedAttachment(fixture, 1, 'safe after audit');
    fixture.push(inbound(2, '/status'));
    const backup = `${fixture.attachmentStagingRoot}-audit-backup`;
    renameSync(fixture.attachmentStagingRoot, backup);
    symlinkSync(backup, fixture.attachmentStagingRoot);

    yield* TestClock.adjust('10 millis');
    yield* waitFor(() => {
      expect(fixture.sent.some((text) => text.includes('Spike ok'))).toBe(true);
      expect(
        fixture.database
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM failures')
          .get()?.count,
      ).toBeGreaterThan(0);
    });
    expect(fixture.inputs).toStrictEqual([]);
    expect(fixture.attachmentInputs).toStrictEqual([]);

    unlinkSync(fixture.attachmentStagingRoot);
    renameSync(backup, fixture.attachmentStagingRoot);
    yield* TestClock.adjust('10 millis');
    yield* waitFor(() => {
      expect(fixture.inputs).toStrictEqual(['safe after audit\n[Image attachment (image/jpeg)]']);
    });
    expect(fixture.attachmentInputs).toStrictEqual([[stagedPath]]);
    yield* Effect.promise(() => Bun.sleep(20));
    expect(fixture.inputs).toHaveLength(1);
    yield* shutdown(fixture, run);
  }),
);
