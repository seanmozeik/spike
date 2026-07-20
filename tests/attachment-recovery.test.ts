import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { openJournal } from '../src/database';
import { ChatGuid, LogicalTurnId, MessageGuid, MessagesRowId } from '../src/domain/ids';
import { makeSchedulerJournal } from '../src/journal/scheduler-journal';
import { makeJournal } from '../src/journal/service';
import type { SchedulerTransition } from '../src/scheduler/model';
import { makeMigratedEngineFixture } from './engine-fixture';
import { seedVersionThirteenAttachmentState } from './version-thirteen-attachment-fixture';

const stagedEntries = (root: string): readonly string[] =>
  readdirSync(root).filter((name) => name !== '.spike-attachment-store-v1');

const waitUntil = async (predicate: () => boolean, deadline = Date.now() + 1000): Promise<void> => {
  if (predicate()) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error('timed out waiting for recovered attachment submission');
  }
  await Bun.sleep(5);
  await waitUntil(predicate, deadline);
};

it.effect('stages a migrated v13 pool before scheduler reload and active recovery', () =>
  Effect.gen(function* recoverPooledAttachments() {
    const gate = Promise.withResolvers<undefined>();
    const fixture = yield* makeMigratedEngineFixture(
      { gate: gate.promise },
      { id: 'thread-v13', turns: [{ id: 'turn-v13', items: [], status: 'inProgress' }] },
      seedVersionThirteenAttachmentState,
    );

    yield* fixture.engine.pollOnce;
    yield* Effect.promise(() => waitUntil(() => fixture.steers.length === 1));

    expect(fixture.steers).toStrictEqual([
      'pooled request\n[Image attachment (image/jpeg)]\n[Image attachment (image/jpeg)]',
    ]);
    expect(fixture.attachmentInputs).toHaveLength(1);
    expect(fixture.attachmentInputs[0]).toHaveLength(2);
    expect(fixture.attachmentInputs[0]?.every((candidate) => existsSync(candidate))).toBe(true);
    expect(
      fixture.database
        .query<{ state: string }, []>(
          "SELECT state FROM attachments WHERE inbound_message_id = 'pooled-message' ORDER BY ordinal",
        )
        .all(),
    ).toStrictEqual([{ state: 'Assigned' }, { state: 'Assigned' }]);
    expect(
      fixture.database
        .query<{ state: string }, []>(
          "SELECT state FROM attachments WHERE inbound_message_id IN ('active-message','terminal-message') ORDER BY inbound_message_id",
        )
        .all(),
    ).toStrictEqual([{ state: 'Failed' }, { state: 'Failed' }, { state: 'Failed' }]);

    fixture.engine.close();
    gate.reject(new Error('stop recovered monitor'));
    yield* fixture.engine.drain;
    fixture.remove();
  }),
);

it.effect('restarts after durable Staged persistence without duplicate CAS or assignment', () =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'spike-attachment-staged-restart-'))),
    (root) =>
      Effect.gen(function* recoverDurableStaging() {
        const databasePath = path.join(root, 'spike.db');
        const sourceRoot = path.join(root, 'Attachments');
        const stagingRoot = path.join(root, 'staged');
        const attachmentName = 'restart.jpg';
        const observedAt = new Date('2026-07-19T10:00:00.000Z');
        const conversation = {
          chatGuid: ChatGuid.make('any;-;+15555550199'),
          handle: '+15555550199',
        };
        mkdirSync(sourceRoot, { recursive: true });
        writeFileSync(path.join(sourceRoot, attachmentName), Buffer.from('FFD8FFD9', 'hex'));

        const first = yield* openJournal(databasePath);
        const firstJournal = makeJournal(first.database, conversation, {
          attachmentStaging: { sourceRoot, stagingBoundary: root, stagingRoot },
        });
        yield* firstJournal.ingestObservedMessages(conversation.chatGuid, observedAt, [
          {
            attachments: [
              {
                attachmentGuid: 'attachment-restart',
                filename: attachmentName,
                mimeType: 'image/jpeg',
                totalBytes: 4,
                transferName: attachmentName,
                uti: 'public.jpeg',
              },
            ],
            chatGuid: conversation.chatGuid,
            handle: conversation.handle,
            isFromMe: false,
            messageGuid: MessageGuid.make('message-restart'),
            rowId: MessagesRowId.make(1),
            sentAt: observedAt,
            service: 'iMessage',
            text: 'restart attachment',
          },
        ]);
        expect(yield* firstJournal.stagePendingAttachments).toBe(1);
        const stagedPath = first.database
          .query<{ staged_path: string; state: string }, []>(
            "SELECT staged_path, state FROM attachments WHERE attachment_guid = 'attachment-restart'",
          )
          .get();
        expect(stagedPath?.state).toBe('Staged');
        expect(stagedPath?.staged_path).toBeDefined();
        first.close();
        expect(stagedEntries(stagingRoot)).toHaveLength(1);

        const restarted = yield* openJournal(databasePath);
        const restartedJournal = makeJournal(restarted.database, conversation, {
          attachmentStaging: { sourceRoot, stagingBoundary: root, stagingRoot },
        });
        expect(yield* restartedJournal.stagePendingAttachments).toBe(0);
        expect(stagedEntries(stagingRoot)).toHaveLength(1);
        const { messages } = yield* restartedJournal.listPendingInbound(
          MessagesRowId.make(0),
          MessagesRowId.make(1),
        );
        const [message] = messages;
        expect(message?.attachments).toHaveLength(1);
        expect(message?.attachments[0]?.path).toBe(stagedPath?.staged_path);

        const scheduler = makeSchedulerJournal(restarted.database);
        const initial = yield* scheduler.loadOrCreate(observedAt);
        const logicalTurnId = LogicalTurnId.make('logical-restart');
        const transition: SchedulerTransition = {
          actions: [
            { kind: 'StartTurn', logicalTurnId, messages: message === undefined ? [] : [message] },
          ],
          state: { ...initial, active: { acknowledged: false, codexTurnId: null, logicalTurnId } },
        };
        yield* scheduler.commitTransition(transition, observedAt);
        restarted.close();

        const verified = yield* openJournal(databasePath);
        const verifiedJournal = makeJournal(verified.database, conversation, {
          attachmentStaging: { sourceRoot, stagingBoundary: root, stagingRoot },
        });
        expect(yield* verifiedJournal.stagePendingAttachments).toBe(0);
        expect(
          yield* verifiedJournal.listPendingInbound(MessagesRowId.make(0), MessagesRowId.make(1)),
        ).toStrictEqual({ blocked: false, controls: [], messages: [] });
        expect(
          verified.database
            .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM input_batch_messages')
            .get()?.count,
        ).toBe(1);
        expect(
          verified.database
            .query<{ state: string }, []>(
              "SELECT state FROM attachments WHERE attachment_guid = 'attachment-restart'",
            )
            .get()?.state,
        ).toBe('Assigned');
        expect(stagedEntries(stagingRoot)).toHaveLength(1);
        verified.close();
      }),
    (root) =>
      Effect.sync(() => {
        rmSync(root, { force: true, recursive: true });
      }),
  ),
);
