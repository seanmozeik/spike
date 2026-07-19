import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import {
  CUTOFF,
  ingest,
  makeRetentionFixture,
  NOW,
  OLD,
  startCodexTurn,
  type RetentionFixture,
} from './retention-fixture';

interface AttachmentPayloadRow {
  readonly attachment_guid: string;
  readonly filename: null | string;
  readonly payload_redacted_at: null | string;
  readonly source_path: null | string;
  readonly state: string;
}

const LATER = new Date('2026-07-16T12:00:00.000Z');

const readAttachments = (fixture: RetentionFixture): readonly AttachmentPayloadRow[] =>
  fixture.database
    .query<AttachmentPayloadRow, []>(
      `SELECT attachment_guid, filename, source_path, state, payload_redacted_at
       FROM attachments ORDER BY attachment_guid`,
    )
    .all();

it.effect('redacts a late attachment whose terminal parent was redacted on an earlier run', () =>
  Effect.gen(function* lateAttachment() {
    const fixture = yield* makeRetentionFixture();
    const terminalMessage = yield* ingest(fixture, 1, 'terminal private input');
    const terminal = yield* startCodexTurn(fixture, 'late-attachment', terminalMessage);
    yield* fixture.scheduler.commitTransition(
      {
        actions: [{ kind: 'CompleteTurn', logicalTurnId: terminal.logicalTurnId }],
        state: { ...fixture.state, active: null },
      },
      OLD,
    );

    expect(yield* fixture.journal.redactTerminalPayloads(CUTOFF, NOW)).toBe(1);
    expect(yield* fixture.journal.listInbound).toMatchObject([{ rowId: 1, text: null }]);

    const reingested = yield* ingest(fixture, 1, 'terminal private input', [
      {
        attachmentGuid: 'late-terminal-attachment',
        filename: 'late-secret.jpg',
        mimeType: 'image/jpeg',
        totalBytes: 42,
        transferName: 'late-secret.jpg',
        uti: 'public.jpeg',
      },
    ]);
    expect(reingested.inserted).toBe(0);
    expect(
      fixture.database
        .query<{ payload_redacted_at: null | string }, []>(
          'SELECT payload_redacted_at FROM inbound_messages WHERE messages_rowid = 1',
        )
        .get(),
    ).toStrictEqual({ payload_redacted_at: NOW.toISOString() });
    yield* ingest(fixture, 2, 'active private input', [
      {
        attachmentGuid: 'active-attachment',
        filename: 'keep-active.jpg',
        mimeType: 'image/jpeg',
        totalBytes: 84,
        transferName: 'keep-active.jpg',
        uti: 'public.jpeg',
      },
    ]);
    expect(readAttachments(fixture)).toStrictEqual([
      {
        attachment_guid: 'active-attachment',
        filename: 'keep-active.jpg',
        payload_redacted_at: null,
        source_path: 'keep-active.jpg',
        state: 'Observed',
      },
      {
        attachment_guid: 'late-terminal-attachment',
        filename: 'late-secret.jpg',
        payload_redacted_at: null,
        source_path: 'late-secret.jpg',
        state: 'Observed',
      },
    ]);

    expect(yield* fixture.journal.redactTerminalPayloads(CUTOFF, LATER)).toBe(0);
    expect(readAttachments(fixture)).toStrictEqual([
      {
        attachment_guid: 'active-attachment',
        filename: 'keep-active.jpg',
        payload_redacted_at: null,
        source_path: 'keep-active.jpg',
        state: 'Observed',
      },
      {
        attachment_guid: 'late-terminal-attachment',
        filename: null,
        payload_redacted_at: LATER.toISOString(),
        source_path: null,
        state: 'Redacted',
      },
    ]);
    expect(yield* fixture.journal.listInbound).toMatchObject([
      { rowId: 1, text: null },
      { rowId: 2, text: 'active private input' },
    ]);
    fixture.close();
  }),
);
