import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { makeAttachmentStore, type AttachmentStore } from '../src/attachments/store';
import { openJournal } from '../src/database';
import { ChatGuid } from '../src/domain/ids';
import { readStagedImages } from '../src/journal/attachment-input';
import { makeJournal } from '../src/journal/service';
import { makeEngineFixture, settle } from './engine-fixture';

const CREATED_AT = '2026-07-19T10:00:00.000Z';
const JPEG = Buffer.from('FFD8FFD9', 'hex');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

interface SeededReference {
  readonly bytes: Buffer;
  readonly contentHash: string;
  readonly id: string;
  readonly inboundId: string;
  readonly path: string;
  readonly state: 'Assigned' | 'Staged';
}

const seedInbound = (
  database: Database,
  id: string,
  rowId: number,
  text: string,
  chatGuid = 'chat',
): void => {
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (?, ?, ?, ?, 'handle', 'iMessage', ?, ?, ?)`,
    [id, `message-${id}`, rowId, chatGuid, text, CREATED_AT, CREATED_AT],
  );
};

const seedReference = (
  database: Database,
  store: AttachmentStore,
  id: string,
  rowId: number,
  state: SeededReference['state'] = 'Staged',
): SeededReference => {
  const inboundId = `inbound-${id}`;
  const bytes = Buffer.concat([JPEG, Buffer.from(id)]);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const stagedPath = store.persist(bytes, contentHash, '.jpg');
  seedInbound(database, inboundId, rowId, `message ${id}`);
  database.run(
    `INSERT INTO attachments(
       id, inbound_message_id, attachment_guid, state, filename, mime_type, total_bytes,
       source_path, staged_path, content_hash, ordinal, created_at
     ) VALUES (?, ?, ?, ?, ?, 'image/jpeg', ?, ?, ?, ?, 0, ?)`,
    [
      id,
      inboundId,
      `guid-${id}`,
      state,
      `${id}.jpg`,
      bytes.byteLength,
      `/Messages/Attachments/${id}.jpg`,
      stagedPath,
      contentHash,
      CREATED_AT,
    ],
  );
  return { bytes, contentHash, id, inboundId, path: stagedPath, state };
};

const databaseFile = (database: Database): string => {
  const entry = database
    .query<{ file: string; name: string; seq: number }, []>('PRAGMA database_list')
    .all()
    .find(({ name }) => name === 'main');
  if (entry === undefined) {
    throw new Error('expected main database path');
  }
  return entry.file;
};

it.effect(
  'fails closed for invalid staged and assigned CAS references while preserving valid rows',
  () =>
    Effect.gen(function* auditMatrix() {
      const root = mkdtempSync(path.join(tmpdir(), 'spike-attachment-integrity-'));
      roots.push(root);
      const stagingRoot = path.join(root, 'staged');
      const handle = yield* openJournal(path.join(root, 'spike.db'));
      const store = makeAttachmentStore(stagingRoot, root);
      const ids = [
        'missing',
        'modified',
        'symlinked',
        'hardlinked',
        'public-mode',
        'noncanonical',
        'hash-mismatch',
        'size-mismatch',
      ] as const;
      const references = new Map<string, SeededReference>();
      for (const [index, id] of [...ids, 'valid-staged', 'valid-assigned'].entries()) {
        references.set(
          id,
          seedReference(
            handle.database,
            store,
            id,
            index + 1,
            id === 'valid-assigned' ? 'Assigned' : 'Staged',
          ),
        );
      }
      const reference = (id: string): SeededReference => {
        const value = references.get(id);
        if (value === undefined) {
          throw new Error(`missing test reference ${id}`);
        }
        return value;
      };

      unlinkSync(reference('missing').path);
      const modified = Buffer.from(reference('modified').bytes);
      modified.set([modified.at(-1) === 0 ? 1 : 0], modified.length - 1);
      writeFileSync(reference('modified').path, modified);
      const symlinkTarget = path.join(root, 'symlink-target.jpg');
      writeFileSync(symlinkTarget, reference('symlinked').bytes);
      unlinkSync(reference('symlinked').path);
      symlinkSync(symlinkTarget, reference('symlinked').path);
      linkSync(reference('hardlinked').path, path.join(root, 'hardlink-copy.jpg'));
      chmodSync(reference('public-mode').path, 0o644);
      const noncanonical = reference('noncanonical');
      const noncanonicalPath = `${stagingRoot}/../${path.basename(stagingRoot)}/${path.basename(noncanonical.path)}`;
      handle.database.run('UPDATE attachments SET staged_path = ? WHERE id = ?', [
        noncanonicalPath,
        noncanonical.id,
      ]);
      handle.database.run('UPDATE attachments SET content_hash = ? WHERE id = ?', [
        '0'.repeat(64),
        'hash-mismatch',
      ]);
      handle.database.run('UPDATE attachments SET total_bytes = total_bytes + 1 WHERE id = ?', [
        'size-mismatch',
      ]);

      const journal = makeJournal(
        handle.database,
        { chatGuid: ChatGuid.make('chat'), handle: 'handle' },
        {
          attachmentStaging: {
            sourceRoot: path.join(root, 'source'),
            stagingBoundary: root,
            stagingRoot,
          },
        },
      );
      expect(yield* journal.auditStagedAttachments).toBe(ids.length);

      for (const id of ids) {
        expect(
          handle.database
            .query<
              {
                content_hash: null;
                failure_code: string;
                filename: null;
                source_path: null;
                staged_path: null;
                state: string;
              },
              [string]
            >(
              `SELECT state, failure_code, staged_path, content_hash, filename, source_path
             FROM attachments WHERE id = ?`,
            )
            .get(id),
        ).toStrictEqual({
          content_hash: null,
          failure_code: 'staged-integrity',
          filename: null,
          source_path: null,
          staged_path: null,
          state: 'Failed',
        });
        expect(readStagedImages(handle.database, reference(id).inboundId)).toStrictEqual([]);
      }

      for (const id of ['valid-staged', 'valid-assigned'] as const) {
        const valid = reference(id);
        expect(
          handle.database
            .query<{ failure_code: null; state: string }, [string]>(
              'SELECT state, failure_code FROM attachments WHERE id = ?',
            )
            .get(id),
        ).toStrictEqual({ failure_code: null, state: valid.state });
        expect(readStagedImages(handle.database, valid.inboundId)).toStrictEqual([
          { contentHash: valid.contentHash, mimeType: 'image/jpeg', path: valid.path },
        ]);
      }

      expect(yield* journal.stagePendingAttachments).toBe(0);
      expect(lstatSync(reference('symlinked').path).isSymbolicLink()).toBe(true);
      expect(lstatSync(reference('hardlinked').path).nlink).toBe(2);
      expect(existsSync(reference('valid-staged').path)).toBe(true);
      expect(existsSync(reference('valid-assigned').path)).toBe(true);
      handle.close();
    }),
);

it.effect('audits a staged symlink before startup recovery can submit it to Codex', () =>
  Effect.gen(function* startupAudit() {
    const fixture = yield* makeEngineFixture({
      idleFrontier: 1,
      prepare: (database) =>
        Effect.sync(() => {
          const root = path.dirname(databaseFile(database));
          const stagingRoot = path.join(root, 'staged-attachments');
          const bytes = Buffer.concat([JPEG, Buffer.from('unsafe-startup')]);
          const contentHash = createHash('sha256').update(bytes).digest('hex');
          const stagedPath = path.join(stagingRoot, `${contentHash}.jpg`);
          const target = path.join(root, 'outside-startup.jpg');
          mkdirSync(stagingRoot, { mode: 0o700, recursive: true });
          writeFileSync(
            path.join(stagingRoot, '.spike-attachment-store-v1'),
            'spike-attachment-store-v1\n',
            { mode: 0o600 },
          );
          writeFileSync(target, bytes);
          symlinkSync(target, stagedPath);
          seedInbound(
            database,
            'unsafe-startup',
            1,
            'unsafe restart attachment',
            'any;-;+15555550199',
          );
          database.run(
            `INSERT INTO attachments(
               id, inbound_message_id, attachment_guid, state, mime_type, total_bytes,
               staged_path, content_hash, ordinal, created_at
             ) VALUES (
               'unsafe-startup', 'unsafe-startup', 'guid-unsafe-startup', 'Staged',
               'image/jpeg', ?, ?, ?, 0, ?
             )`,
            [bytes.byteLength, stagedPath, contentHash, CREATED_AT],
          );
        }),
    });

    expect(
      fixture.database
        .query<{ failure_code: string; staged_path: null; state: string }, []>(
          `SELECT state, failure_code, staged_path FROM attachments
           WHERE id = 'unsafe-startup'`,
        )
        .get(),
    ).toStrictEqual({ failure_code: 'staged-integrity', staged_path: null, state: 'Failed' });
    yield* settle(fixture.engine);
    expect(fixture.inputs).toStrictEqual([
      'unsafe restart attachment\n[Attachment rejected: staged-integrity]',
    ]);
    expect(fixture.attachmentInputs).toStrictEqual([[]]);
    fixture.remove();
  }),
);
