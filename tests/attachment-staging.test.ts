import type { Database } from 'bun:sqlite';
import { once } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { afterEach, expect } from 'vitest';

import { AttachmentStagingPermissionError } from '../src/attachments/errors';
import { makeAttachmentStore, type AttachmentStore } from '../src/attachments/store';
import { openJournal } from '../src/database';
import {
  ChatGuid,
  GenerationId,
  LogicalTurnId,
  MessageGuid,
  MessagesRowId,
} from '../src/domain/ids';
import { JournalTransactionError } from '../src/errors';
import {
  makeStagePendingAttachments,
  type AttachmentStagingOptions,
} from '../src/journal/attachment-staging';
import { makeListPendingInbound } from '../src/journal/inbound-recovery';
import { makeSchedulerJournal } from '../src/journal/scheduler-journal';
import { makeJournal } from '../src/journal/service';
import { spikePaths } from '../src/paths';

const roots: string[] = [];
const CREATED_AT = '2026-07-19T10:00:00.000Z';

afterEach(() => {
  for (const root of roots.splice(0)) {
    const messagesRoot = path.join(root, 'Messages', 'Attachments');
    const stateRoot = path.join(root, 'spike-home', 'state');
    if (existsSync(messagesRoot)) {
      chmodSync(messagesRoot, 0o700);
    }
    if (existsSync(stateRoot)) {
      chmodSync(stateRoot, 0o700);
    }
    rmSync(root, { force: true, recursive: true });
  }
});

interface StagingFixture {
  readonly attachmentStore: AttachmentStore;
  readonly close: () => void;
  readonly database: Database;
  readonly databasePath: string;
  readonly messagesRoot: string;
  readonly root: string;
  readonly stagingRoot: string;
}

const makeFixture = (): Effect.Effect<StagingFixture, unknown> =>
  Effect.gen(function* fixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-attachment-'));
    roots.push(root);
    const messagesRoot = path.join(root, 'Messages', 'Attachments');
    const paths = spikePaths(path.join(root, 'spike-home'));
    mkdirSync(messagesRoot, { mode: 0o700, recursive: true });
    mkdirSync(paths.state, { mode: 0o700, recursive: true });
    const handle = yield* openJournal(paths.database);
    let closed = false;
    return {
      attachmentStore: makeAttachmentStore(paths.attachments, paths.state),
      close: (): void => {
        if (!closed) {
          closed = true;
          handle.close();
        }
      },
      database: handle.database,
      databasePath: paths.database,
      messagesRoot,
      root,
      stagingRoot: paths.attachments,
    };
  });

type StagingOverrides = Omit<Partial<AttachmentStagingOptions>, 'sourceRoot' | 'stagingRoot'>;

const stagePending = (
  fixture: StagingFixture,
  overrides: StagingOverrides = {},
): ReturnType<typeof makeStagePendingAttachments> =>
  makeStagePendingAttachments(
    fixture.database,
    { ...overrides, sourceRoot: fixture.messagesRoot },
    fixture.attachmentStore,
  );

const seedInbound = (database: Database, id: string, rowId: number, text: string | null): void => {
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (?, ?, ?, 'chat', 'handle', 'iMessage', ?, ?, ?)`,
    [id, `message-${id}`, rowId, text, CREATED_AT, CREATED_AT],
  );
};

const seedAttachment = (
  database: Database,
  input: {
    readonly guid?: string;
    readonly id: string;
    readonly inboundId: string;
    readonly mimeType?: null | string;
    readonly ordinal?: number;
    readonly sourcePath: string | null;
    readonly transferName?: null | string;
  },
): void => {
  database.run(
    `INSERT INTO attachments(
       id, inbound_message_id, attachment_guid, state, filename, transfer_name, mime_type,
       source_path, ordinal, created_at
     ) VALUES (?, ?, ?, 'Observed', ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.inboundId,
      input.guid ?? `guid-${input.id}`,
      input.sourcePath,
      input.transferName ?? input.sourcePath,
      input.mimeType ?? null,
      input.sourcePath,
      input.ordinal ?? 0,
      CREATED_AT,
    ],
  );
};

const PNG = Buffer.from('89504E470D0A1A0A', 'hex');
const JPEG = Buffer.from('FFD8FFD9', 'hex');
const GIF = new TextEncoder().encode('GIF89a');
const WEBP = Buffer.from('524946460000000057454250', 'hex');
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const stagedEntries = (root: string): readonly string[] =>
  readdirSync(root).filter((name) => name !== '.spike-attachment-store-v1');

it.effect('deduplicates the same Messages GUID across ingestion retries', () =>
  Effect.gen(function* guidRetry() {
    const fixture = yield* makeFixture();
    writeFileSync(path.join(fixture.messagesRoot, 'retry.png'), PNG);
    const chatGuid = ChatGuid.make('chat');
    const journal = makeJournal(
      fixture.database,
      { chatGuid, handle: 'handle' },
      {
        attachmentStaging: {
          sourceRoot: fixture.messagesRoot,
          stagingBoundary: fixture.root,
          stagingRoot: fixture.stagingRoot,
        },
      },
    );
    const message = {
      attachments: [
        {
          attachmentGuid: 'stable-attachment-guid',
          filename: 'retry.png',
          mimeType: 'image/png',
          totalBytes: PNG.byteLength,
          transferName: 'retry.png',
          uti: 'public.png',
        },
      ],
      chatGuid,
      handle: 'handle',
      isFromMe: false,
      messageGuid: MessageGuid.make('stable-message-guid'),
      rowId: MessagesRowId.make(1),
      sentAt: new Date(CREATED_AT),
      service: 'iMessage',
      text: null,
    } as const;
    expect(yield* journal.ingestObservedMessages(chatGuid, new Date(CREATED_AT), [message])).toBe(
      1,
    );
    expect(yield* journal.ingestObservedMessages(chatGuid, new Date(CREATED_AT), [message])).toBe(
      0,
    );
    expect(
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM attachments')
        .get()?.count,
    ).toBe(1);
    expect(yield* journal.stagePendingAttachments).toBe(1);
    expect(yield* journal.stagePendingAttachments).toBe(0);
    fixture.close();
  }),
);

it.effect('stages supported images with generated owner-only names and hash deduplication', () =>
  Effect.gen(function* supportedImages() {
    const fixture = yield* makeFixture();
    seedInbound(fixture.database, 'inbound', 1, 'inspect these');
    const files = [
      ['jpeg', JPEG],
      ['png', PNG],
      ['gif', GIF],
      ['webp', WEBP],
      ['jpeg-copy', JPEG],
    ] as const;
    for (const [ordinal, [name, bytes]] of files.entries()) {
      writeFileSync(path.join(fixture.messagesRoot, name), bytes);
      seedAttachment(fixture.database, {
        id: name,
        inboundId: 'inbound',
        ordinal,
        sourcePath: name,
      });
    }

    expect(yield* stagePending(fixture)).toBe(5);
    const rows = fixture.database
      .query<
        {
          content_hash: string;
          filename: null | string;
          mime_type: string;
          source_path: null | string;
          staged_path: string;
          state: string;
        },
        []
      >(
        `SELECT content_hash, filename, mime_type, source_path, staged_path, state
         FROM attachments ORDER BY ordinal`,
      )
      .all();
    expect(rows.map(({ mime_type }) => mime_type)).toStrictEqual([
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/jpeg',
    ]);
    expect(
      rows.every(
        ({ filename, source_path, state }) =>
          filename === null && source_path === null && state === 'Staged',
      ),
    ).toBe(true);
    expect(rows[0]?.staged_path).toBe(rows[4]?.staged_path);
    expect(stagedEntries(fixture.stagingRoot)).toHaveLength(4);
    expect(lstatSync(fixture.stagingRoot).mode % 0o1000).toBe(0o700);
    for (const file of stagedEntries(fixture.stagingRoot)) {
      expect(lstatSync(path.join(fixture.stagingRoot, file)).mode % 0o1000).toBe(0o600);
      expect(file).toMatch(/^[a-f0-9]{64}\.(?:gif|jpg|png|webp)$/u);
    }
    expect(yield* stagePending(fixture)).toBe(0);
    fixture.close();
  }),
);

it.effect('leaves a changing source Observed until a stable read reaches EOF', () =>
  Effect.gen(function* changingSource() {
    const fixture = yield* makeFixture();
    const source = path.join(fixture.messagesRoot, 'growing.png');
    const suffix = Buffer.from('AABBCC', 'hex');
    seedInbound(fixture.database, 'inbound', 1, 'growing image');
    seedInbound(fixture.database, 'later', 2, 'later ordinary message');
    writeFileSync(source, PNG);
    seedAttachment(fixture.database, {
      id: 'growing',
      inboundId: 'inbound',
      sourcePath: 'growing.png',
    });
    let appended = false;

    expect(
      yield* stagePending(fixture, {
        afterSourceStat: (openedPath) => {
          if (!appended) {
            appended = true;
            appendFileSync(openedPath, suffix);
          }
        },
      }),
    ).toBe(0);
    expect(
      fixture.database
        .query<{ state: string }, [string]>('SELECT state FROM attachments WHERE id = ?')
        .get('growing'),
    ).toStrictEqual({ state: 'Observed' });
    expect(stagedEntries(fixture.stagingRoot)).toStrictEqual([]);
    expect(
      yield* makeListPendingInbound(fixture.database)(MessagesRowId.make(0), MessagesRowId.make(2)),
    ).toStrictEqual({ blocked: true, controls: [], messages: [] });

    expect(yield* stagePending(fixture)).toBe(1);
    expect(
      fixture.database
        .query<{ state: string; total_bytes: number }, [string]>(
          'SELECT state, total_bytes FROM attachments WHERE id = ?',
        )
        .get('growing'),
    ).toStrictEqual({ state: 'Staged', total_bytes: PNG.byteLength + suffix.byteLength });
    expect(
      (yield* makeListPendingInbound(fixture.database)(
        MessagesRowId.make(0),
        MessagesRowId.make(2),
      )).messages.map(({ text }) => text),
    ).toStrictEqual(['growing image\n[Image attachment (image/png)]', 'later ordinary message']);
    fixture.close();
  }),
);

it.effect('opens FIFOs nonblocking and rejects FIFOs and sockets as device files', () =>
  Effect.gen(function* specialFiles() {
    const fixture = yield* makeFixture();
    const fifo = path.join(fixture.messagesRoot, 'attachment.fifo');
    const socket = path.join(fixture.messagesRoot, 'attachment.socket');
    const created = Bun.spawnSync(['mkfifo', fifo]);
    expect(created.exitCode).toBe(0);
    const server = createServer();
    yield* Effect.acquireUseRelease(
      Effect.promise(async () => {
        const listening = once(server, 'listening');
        server.listen(socket);
        await listening;
      }),
      () =>
        Effect.sync(() => {
          seedInbound(fixture.database, 'inbound', 1, null);
          seedAttachment(fixture.database, {
            id: 'fifo',
            inboundId: 'inbound',
            sourcePath: 'attachment.fifo',
          });
          seedAttachment(fixture.database, {
            id: 'socket',
            inboundId: 'inbound',
            ordinal: 1,
            sourcePath: 'attachment.socket',
          });
        }).pipe(
          Effect.andThen(stagePending(fixture)),
          Effect.tap((count) =>
            Effect.sync(() => {
              expect(count).toBe(2);
            }),
          ),
        ),
      () =>
        Effect.promise(async () => {
          const closed = once(server, 'close');
          server.close();
          await closed;
        }),
    );
    expect(
      fixture.database
        .query<{ failure_code: string; state: string }, []>(
          'SELECT state, failure_code FROM attachments ORDER BY ordinal',
        )
        .all(),
    ).toStrictEqual([
      { failure_code: 'device-file', state: 'Failed' },
      { failure_code: 'device-file', state: 'Failed' },
    ]);
    fixture.close();
  }),
);

it.effect('sweeps only strict temporary and unreferenced CAS names', () =>
  Effect.gen(function* sweepStore() {
    const fixture = yield* makeFixture();
    expect(yield* stagePending(fixture)).toBe(0);
    const temporary = '.00000000-0000-4000-8000-000000000000.tmp';
    const orphan = `${'0'.repeat(64)}.png`;
    const unknown = 'operator-note';
    for (const name of [temporary, orphan, unknown]) {
      writeFileSync(path.join(fixture.stagingRoot, name), PNG);
    }

    expect(yield* stagePending(fixture)).toBe(0);
    expect(stagedEntries(fixture.stagingRoot)).toStrictEqual([unknown]);
    fixture.close();
  }),
);

it.effect('stages generic files and exposes their durable absolute paths to the model', () =>
  Effect.gen(function* genericFiles() {
    const fixture = yield* makeFixture();
    seedInbound(fixture.database, 'inbound', 1, 'inspect these files');
    const files = [
      ['pdf', 'brief.PDF', 'application/pdf', new TextEncoder().encode('%PDF-1.7')],
      ['audio', 'voice.m4a', 'audio/mp4', Buffer.from('00000018667479704d344120', 'hex')],
      ['document', 'notes.docx', null, Buffer.from('504B0304', 'hex')],
    ] as const;
    for (const [ordinal, [id, name, mimeType, bytes]] of files.entries()) {
      writeFileSync(path.join(fixture.messagesRoot, name), bytes);
      seedAttachment(fixture.database, {
        id,
        inboundId: 'inbound',
        mimeType,
        ordinal,
        sourcePath: name,
        transferName: name,
      });
    }

    expect(yield* stagePending(fixture)).toBe(files.length);
    const rows = fixture.database
      .query<{ mime_type: null | string; staged_path: string; total_bytes: number }, []>(
        'SELECT mime_type, staged_path, total_bytes FROM attachments ORDER BY ordinal',
      )
      .all();
    expect(rows.map(({ staged_path }) => path.extname(staged_path))).toStrictEqual([
      '.pdf',
      '.m4a',
      '.docx',
    ]);
    expect(rows.map(({ mime_type }) => mime_type)).toStrictEqual([
      'application/pdf',
      'audio/mp4',
      null,
    ]);
    for (const { staged_path: stagedPath } of rows) {
      expect(path.isAbsolute(stagedPath)).toBe(true);
      expect(path.dirname(stagedPath)).toBe(fixture.stagingRoot);
      expect(lstatSync(stagedPath).mode % 0o1000).toBe(0o600);
    }
    expect(yield* stagePending(fixture)).toBe(0);
    const { messages } = yield* makeListPendingInbound(fixture.database)(
      MessagesRowId.make(0),
      MessagesRowId.make(1),
    );
    expect(messages[0]?.attachments).toStrictEqual([]);
    expect(messages[0]?.text).toBe(
      [
        'inspect these files',
        `[Attachment available at ${rows[0]?.staged_path} (application/pdf)]`,
        `[Attachment available at ${rows[1]?.staged_path} (audio/mp4)]`,
        `[Attachment available at ${rows[2]?.staged_path}]`,
      ].join('\n'),
    );
    const [pending] = messages;
    if (pending === undefined) {
      throw new Error('expected pending generic attachment message');
    }
    const scheduler = makeSchedulerJournal(fixture.database);
    const state = yield* scheduler.loadOrCreate(new Date(CREATED_AT));
    yield* scheduler.commitTransition(
      { actions: [], state: { ...state, pool: [pending] } },
      new Date(CREATED_AT),
    );
    expect((yield* scheduler.loadOrCreate(new Date(CREATED_AT))).pool[0]?.text).toBe(pending.text);
    fixture.close();
  }),
);

it.effect('converts HEIC images to bounded JPEG local-image inputs', () =>
  Effect.gen(function* heicConversion() {
    const fixture = yield* makeFixture();
    seedInbound(fixture.database, 'inbound', 1, 'inspect this photo');
    const heic = yield* Effect.promise(() =>
      new Bun.Image(VALID_PNG, { maxPixels: 10 }).heic({ quality: 80 }).bytes(),
    );
    writeFileSync(path.join(fixture.messagesRoot, 'photo.heic'), heic);
    seedAttachment(fixture.database, {
      id: 'heic',
      inboundId: 'inbound',
      mimeType: 'image/heic',
      sourcePath: 'photo.heic',
    });

    expect(yield* stagePending(fixture)).toBe(1);
    const row = fixture.database
      .query<
        { content_hash: string; mime_type: string; staged_path: string; total_bytes: number },
        []
      >('SELECT content_hash, mime_type, staged_path, total_bytes FROM attachments')
      .get();
    expect(row?.mime_type).toBe('image/jpeg');
    expect(row?.staged_path).toMatch(/[a-f0-9]{64}\.jpg$/u);
    expect(readFileSync(row?.staged_path ?? '').subarray(0, 3)).toStrictEqual(
      Buffer.from('FFD8FF', 'hex'),
    );
    expect(row?.total_bytes).toBe(lstatSync(row?.staged_path ?? '').size);
    const { messages } = yield* makeListPendingInbound(fixture.database)(
      MessagesRowId.make(0),
      MessagesRowId.make(1),
    );
    expect(messages[0]?.text).toBe('inspect this photo\n[Image attachment (image/jpeg)]');
    expect(messages[0]?.attachments).toStrictEqual([
      { contentHash: row?.content_hash, mimeType: 'image/jpeg', path: row?.staged_path },
    ]);
    fixture.close();
  }),
);

it.effect('rejects traversal, symlinks, non-files, oversize data, and invalid HEIC', () =>
  Effect.gen(function* rejectedInputs() {
    const fixture = yield* makeFixture();
    seedInbound(fixture.database, 'inbound', 1, null);
    writeFileSync(path.join(fixture.root, 'outside.png'), PNG);
    writeFileSync(path.join(fixture.messagesRoot, 'safe.png'), PNG);
    symlinkSync(
      path.join(fixture.messagesRoot, 'safe.png'),
      path.join(fixture.messagesRoot, 'link.png'),
    );
    mkdirSync(path.join(fixture.messagesRoot, 'directory'));
    writeFileSync(path.join(fixture.messagesRoot, 'large.bin'), new Uint8Array(33));
    writeFileSync(
      path.join(fixture.messagesRoot, 'photo.heic'),
      new TextEncoder().encode('\0\0\0\0ftypheic'),
    );
    const cases = [
      ['traversal', '../outside.png', 'outside-messages-root'],
      ['symlink', 'link.png', 'symlink'],
      ['directory', 'directory', 'device-file'],
      ['oversize', 'large.bin', 'oversize'],
      ['heic', 'photo.heic', 'heic-unsupported'],
      ['missing', null, 'missing-source'],
    ] as const;
    for (const [ordinal, [id, sourcePath]] of cases.entries()) {
      seedAttachment(fixture.database, { id, inboundId: 'inbound', ordinal, sourcePath });
    }

    expect(yield* stagePending(fixture, { maxBytes: 32 })).toBe(cases.length);
    expect(
      fixture.database
        .query<{ failure_code: string; id: string; source_path: null; state: string }, []>(
          `SELECT id, failure_code, source_path, state FROM attachments ORDER BY ordinal`,
        )
        .all(),
    ).toStrictEqual(
      cases.map(([id, , failureCode]) => ({
        failure_code: failureCode,
        id,
        source_path: null,
        state: 'Failed',
      })),
    );
    expect(stagedEntries(fixture.stagingRoot)).toStrictEqual([]);
    fixture.close();
  }),
);

it.effect('rejects a source when an ancestor is replaced by a symlink before open', () =>
  Effect.gen(function* ancestorSwap() {
    const fixture = yield* makeFixture();
    const nested = path.join(fixture.messagesRoot, 'nested');
    const relocated = path.join(fixture.messagesRoot, 'nested-before-swap');
    const outside = path.join(fixture.root, 'outside');
    mkdirSync(nested);
    mkdirSync(outside);
    writeFileSync(path.join(nested, 'photo.png'), PNG);
    writeFileSync(path.join(outside, 'photo.png'), PNG);
    seedInbound(fixture.database, 'inbound', 1, 'swapped image');
    seedAttachment(fixture.database, {
      id: 'ancestor-swap',
      inboundId: 'inbound',
      sourcePath: 'nested/photo.png',
    });

    expect(
      yield* stagePending(fixture, {
        beforeSourceOpen: () => {
          renameSync(nested, relocated);
          symlinkSync(outside, nested, 'dir');
        },
      }),
    ).toBe(1);
    expect(
      fixture.database
        .query<{ failure_code: string; state: string }, []>(
          'SELECT state, failure_code FROM attachments',
        )
        .get(),
    ).toStrictEqual({ failure_code: 'symlink', state: 'Failed' });
    expect(stagedEntries(fixture.stagingRoot)).toStrictEqual([]);
    expect(readFileSync(path.join(outside, 'photo.png'))).toStrictEqual(PNG);
    fixture.close();
  }),
);

it.effect('keeps permission denial bounded and path-free', () =>
  Effect.gen(function* permissionDenied() {
    const fixture = yield* makeFixture();
    seedInbound(fixture.database, 'inbound', 1, null);
    writeFileSync(path.join(fixture.messagesRoot, 'private.png'), PNG);
    seedAttachment(fixture.database, {
      id: 'private',
      inboundId: 'inbound',
      sourcePath: 'private.png',
    });
    chmodSync(fixture.messagesRoot, 0o000);
    const result = yield* Effect.result(stagePending(fixture));
    chmodSync(fixture.messagesRoot, 0o700);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(AttachmentStagingPermissionError);
      expect(String(result.failure)).not.toContain('private.png');
      expect(result.failure.message).toContain('Full Disk Access');
    }
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM attachments').get(),
    ).toStrictEqual({ state: 'Observed' });
    fixture.close();
  }),
);

it.effect('normalizes a non-writable staging destination as a permission outage', () =>
  Effect.gen(function* nonWritableStaging() {
    const fixture = yield* makeFixture();
    expect(yield* stagePending(fixture)).toBe(0);
    seedInbound(fixture.database, 'inbound', 1, null);
    writeFileSync(path.join(fixture.messagesRoot, 'photo.png'), PNG);
    seedAttachment(fixture.database, {
      id: 'photo',
      inboundId: 'inbound',
      sourcePath: 'photo.png',
    });
    rmSync(fixture.stagingRoot, { recursive: true });
    const stagingParent = path.dirname(fixture.stagingRoot);
    chmodSync(stagingParent, 0o500);
    const result = yield* Effect.result(stagePending(fixture));
    chmodSync(stagingParent, 0o700);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(AttachmentStagingPermissionError);
      expect(result.failure.message).toContain('Full Disk Access');
      expect(String(result.failure)).not.toContain(fixture.stagingRoot);
    }
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM attachments').get(),
    ).toStrictEqual({ state: 'Observed' });
    fixture.close();
  }),
);

it.effect('refuses a symlinked staging root without writing through it', () =>
  Effect.gen(function* symlinkedStagingRoot() {
    const fixture = yield* makeFixture();
    expect(yield* stagePending(fixture)).toBe(0);
    seedInbound(fixture.database, 'inbound', 1, null);
    writeFileSync(path.join(fixture.messagesRoot, 'photo.png'), PNG);
    seedAttachment(fixture.database, {
      id: 'photo',
      inboundId: 'inbound',
      sourcePath: 'photo.png',
    });
    const outsideStagingRoot = path.join(fixture.root, 'outside-staging');
    mkdirSync(outsideStagingRoot);
    rmSync(fixture.stagingRoot, { recursive: true });
    symlinkSync(outsideStagingRoot, fixture.stagingRoot);

    const result = yield* Effect.result(stagePending(fixture));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(JournalTransactionError);
      expect(String(result.failure)).not.toContain(outsideStagingRoot);
    }
    expect(readdirSync(outsideStagingRoot)).toStrictEqual([]);
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM attachments').get(),
    ).toStrictEqual({ state: 'Observed' });
    fixture.close();
  }),
);

it('refuses a pre-existing attachment root without Spike ownership', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-attachment-unowned-'));
  roots.push(root);
  const boundary = path.join(root, 'work');
  const stagingRoot = path.join(boundary, 'tmp', 'spike', 'attachments');
  mkdirSync(stagingRoot, { recursive: true });
  const operatorFile = path.join(stagingRoot, `${'0'.repeat(64)}.pdf`);
  writeFileSync(operatorFile, 'operator data');
  const store = makeAttachmentStore(stagingRoot, boundary);

  expect(() => store.sweep([])).toThrow('not owned by Spike');
  expect(readFileSync(operatorFile, 'utf8')).toBe('operator data');
});

it('refuses a symlinked staging ancestor without writing outside the working directory', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-attachment-parent-symlink-'));
  roots.push(root);
  const boundary = path.join(root, 'work');
  const outside = path.join(root, 'outside');
  mkdirSync(boundary);
  mkdirSync(outside);
  symlinkSync(outside, path.join(boundary, 'tmp'));
  const stagingRoot = path.join(boundary, 'tmp', 'spike', 'attachments');
  const store = makeAttachmentStore(stagingRoot, boundary);

  expect(() => store.persist(PNG, '0'.repeat(64), '.png')).toThrow(
    'ancestor is not a regular directory',
  );
  expect(readdirSync(outside)).toStrictEqual([]);
});

it.effect('reconciles the copy-before-journal crash window and assigns before recovery', () =>
  Effect.gen(function* crashAndRecovery() {
    const fixture = yield* makeFixture();
    seedInbound(fixture.database, 'inbound', 1, 'look');
    writeFileSync(path.join(fixture.messagesRoot, 'photo.png'), PNG);
    seedAttachment(fixture.database, {
      id: 'photo',
      inboundId: 'inbound',
      sourcePath: 'photo.png',
    });
    const crashed = yield* Effect.result(
      stagePending(fixture, {
        afterCopy: () => {
          throw new Error('simulated crash');
        },
      }),
    );
    expect(Result.isFailure(crashed)).toBe(true);
    const [orphanName] = stagedEntries(fixture.stagingRoot);
    expect(orphanName).toBeDefined();
    if (orphanName === undefined) {
      throw new Error('expected orphaned CAS file');
    }
    const orphanPath = path.join(fixture.stagingRoot, orphanName);
    const orphanInode = lstatSync(orphanPath).ino;
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM attachments').get(),
    ).toStrictEqual({ state: 'Observed' });

    expect(yield* stagePending(fixture)).toBe(1);
    expect(stagedEntries(fixture.stagingRoot)).toStrictEqual([orphanName]);
    expect(lstatSync(orphanPath).ino).toBe(orphanInode);
    const { messages } = yield* makeListPendingInbound(fixture.database)(
      MessagesRowId.make(0),
      MessagesRowId.make(1),
    );
    const [pending] = messages;
    expect(pending?.attachments).toHaveLength(1);
    if (pending === undefined) {
      throw new Error('expected staged inbound message');
    }
    const scheduler = makeSchedulerJournal(fixture.database);
    const state = yield* scheduler.loadOrCreate(new Date(CREATED_AT));
    const logicalTurnId = LogicalTurnId.make('turn');
    const runningState = {
      ...state,
      active: { acknowledged: false, codexTurnId: null, logicalTurnId },
      generationId: GenerationId.make(state.generationId),
    } as const;
    yield* scheduler.commitTransition(
      { actions: [{ kind: 'StartTurn', logicalTurnId, messages: [pending] }], state: runningState },
      new Date(CREATED_AT),
    );
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM attachments').get(),
    ).toStrictEqual({ state: 'Assigned' });
    fixture.close();
    const reopened = yield* openJournal(fixture.databasePath);
    const recoveryScheduler = makeSchedulerJournal(reopened.database);
    const [batch] = yield* recoveryScheduler.loadInputBatches(logicalTurnId, 'Initial');
    const stagedPath = batch?.messages[0]?.attachments[0]?.path;
    expect(stagedPath).toMatch(/[a-f0-9]{64}\.png$/u);
    expect(stagedPath === undefined ? false : existsSync(stagedPath)).toBe(true);

    yield* recoveryScheduler.commitTransition(
      {
        actions: [{ kind: 'CompleteTurn', logicalTurnId }],
        state: { ...runningState, active: null },
      },
      new Date('2026-07-19T10:01:00.000Z'),
    );
    const journal = makeJournal(
      reopened.database,
      { chatGuid: ChatGuid.make('chat'), handle: 'handle' },
      {
        attachmentStaging: {
          sourceRoot: fixture.messagesRoot,
          stagingBoundary: fixture.root,
          stagingRoot: fixture.stagingRoot,
        },
      },
    );
    expect(
      yield* journal.redactTerminalPayloads(
        new Date('2026-07-20T00:00:00.000Z'),
        new Date('2026-07-21T00:00:00.000Z'),
      ),
    ).toBe(1);
    expect(stagedPath === undefined ? true : existsSync(stagedPath)).toBe(false);
    expect(
      reopened.database
        .query<{ staged_path: null; state: string }, []>(
          'SELECT staged_path, state FROM attachments',
        )
        .get(),
    ).toStrictEqual({ staged_path: null, state: 'Redacted' });
    reopened.close();
  }),
);
