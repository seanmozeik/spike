import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { canonicalInputFingerprint } from '../src/codex/reconcile';
import { openJournal } from '../src/database';
import { ChatGuid, LogicalTurnId } from '../src/domain/ids';
import { makeCodexJournal } from '../src/journal/codex-journal';
import { makeSchedulerJournal } from '../src/journal/scheduler-journal';
import { makeJournal } from '../src/journal/service';
import {
  ACTIVE_INPUT,
  seedVersionFourteenAttachmentState,
  seedVersionThirteenAttachmentState,
} from './version-thirteen-attachment-fixture';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it.effect('migrates a real v13 journal through account v14, attachment v15, and recovery v16', () =>
  Effect.gen(function* migrateAttachmentState() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-attachment-v13-'));
    roots.push(root);
    const sourceRoot = path.join(root, 'Attachments');
    const stagingRoot = path.join(root, 'staged');
    const databasePath = path.join(root, 'spike.db');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(path.join(sourceRoot, 'photo.jpg'), Buffer.from('ffd8ffd9', 'hex'));
    const bootstrap = yield* openJournal(databasePath);
    bootstrap.close();
    seedVersionThirteenAttachmentState(databasePath);

    const migrated = yield* openJournal(databasePath);
    expect(
      migrated.database
        .query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_meta')
        .get()?.version,
    ).toBe(16);
    expect(
      migrated.database
        .query<{ name: string }, []>("PRAGMA index_list('attachments')")
        .all()
        .map(({ name }) => name),
    ).toEqual(expect.arrayContaining(['attachments_staged_path', 'attachments_inbound_message']));
    expect(
      migrated.database
        .query<{ mode: string; selected_at: null | string }, []>(
          "SELECT mode, selected_at FROM account_observations WHERE account_id = 'legacy-account'",
        )
        .get(),
    ).toStrictEqual({ mode: 'Capacity', selected_at: null });
    const beforeStaging = migrated.database
      .query<
        {
          failure_code: null | string;
          id: string;
          ordinal: number;
          source_path: null | string;
          state: string;
        },
        []
      >(
        `SELECT id, state, failure_code, source_path, ordinal
         FROM attachments ORDER BY inbound_message_id, ordinal`,
      )
      .all();
    expect(beforeStaging).toStrictEqual([
      {
        failure_code: 'legacy-claimed',
        id: 'active-attachment',
        ordinal: 0,
        source_path: null,
        state: 'Failed',
      },
      {
        failure_code: 'legacy-claimed',
        id: 'active-attachment-two',
        ordinal: 1,
        source_path: null,
        state: 'Failed',
      },
      {
        failure_code: null,
        id: 'pooled-attachment-one',
        ordinal: 0,
        source_path: 'photo.jpg',
        state: 'Observed',
      },
      {
        failure_code: null,
        id: 'pooled-attachment-two',
        ordinal: 1,
        source_path: 'fixture-two.jpg',
        state: 'Observed',
      },
      {
        failure_code: 'legacy-claimed',
        id: 'terminal-attachment',
        ordinal: 0,
        source_path: null,
        state: 'Failed',
      },
    ]);

    const journal = makeJournal(
      migrated.database,
      { chatGuid: ChatGuid.make('any;-;+15555550199'), handle: '+15555550199' },
      { attachmentStaging: { sourceRoot, stagingRoot } },
    );
    expect(yield* journal.stagePendingAttachments).toBe(2);
    expect(readdirSync(stagingRoot)).toHaveLength(2);
    expect(
      migrated.database
        .query<{ id: string; state: string }, []>(
          'SELECT id, state FROM attachments ORDER BY inbound_message_id, ordinal',
        )
        .all(),
    ).toStrictEqual([
      { id: 'active-attachment', state: 'Failed' },
      { id: 'active-attachment-two', state: 'Failed' },
      { id: 'pooled-attachment-one', state: 'Staged' },
      { id: 'pooled-attachment-two', state: 'Staged' },
      { id: 'terminal-attachment', state: 'Failed' },
    ]);

    const scheduler = makeSchedulerJournal(migrated.database);
    const state = yield* scheduler.loadOrCreate(new Date('2026-07-14T12:00:00.000Z'));
    expect(state.pool).toHaveLength(1);
    expect(state.pool[0]?.attachments).toHaveLength(2);
    const [activeBatch] = yield* scheduler.loadInputBatches(
      LogicalTurnId.make('active-v13'),
      'Initial',
    );
    expect(activeBatch?.messages[0]).toMatchObject({ attachments: [], text: ACTIVE_INPUT });
    const [attempt] = yield* makeCodexJournal(migrated.database).loadNonterminalAttempts;
    expect(attempt?.inputFingerprint).toBe(canonicalInputFingerprint(ACTIVE_INPUT));
    migrated.close();
  }),
);

it.effect('migrates a real v14 attachment journal through v15 and v16', () =>
  Effect.gen(function* migrateVersionFourteen() {
    const root = mkdtempSync(path.join(tmpdir(), 'spike-attachment-v14-'));
    roots.push(root);
    const sourceRoot = path.join(root, 'Attachments');
    const databasePath = path.join(root, 'spike.db');
    mkdirSync(sourceRoot, { recursive: true });
    const bootstrap = yield* openJournal(databasePath);
    bootstrap.close();
    seedVersionFourteenAttachmentState(databasePath);

    const migrated = yield* openJournal(databasePath);
    expect(
      migrated.database
        .query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_meta')
        .get()?.version,
    ).toBe(16);
    expect(
      migrated.database
        .query<{ name: string }, []>('PRAGMA table_info(account_observations)')
        .all()
        .map(({ name }) => name),
    ).toEqual(expect.arrayContaining(['mode', 'selected_at']));
    expect(
      migrated.database
        .query<{ name: string }, []>('PRAGMA table_info(attachments)')
        .all()
        .map(({ name }) => name),
    ).toEqual(expect.arrayContaining(['failure_code', 'ordinal']));
    expect(
      migrated.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM attachments WHERE failure_code = 'legacy-claimed'",
        )
        .get()?.count,
    ).toBe(3);
    expect(
      migrated.database
        .query<{ ordinal: number }, []>(
          "SELECT ordinal FROM attachments WHERE inbound_message_id = 'pooled-message' ORDER BY ordinal",
        )
        .all(),
    ).toStrictEqual([{ ordinal: 0 }, { ordinal: 1 }]);
    expect(
      migrated.database
        .query<{ name: string }, []>("PRAGMA index_list('attachments')")
        .all()
        .map(({ name }) => name),
    ).toEqual(expect.arrayContaining(['attachments_staged_path', 'attachments_inbound_message']));
    migrated.close();
  }),
);
