import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { inspectJournal, openJournal } from '../src/database';
import { PENDING_INBOUND_QUERY } from '../src/journal/recovery-query';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const makeDatabasePath = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-recovery-index-'));
  roots.push(root);
  return path.join(root, 'spike.db');
};

it.effect('migrates a real schema v15 journal to the v16 recovery index', () =>
  Effect.gen(function* migrateRecoveryIndex() {
    const databasePath = makeDatabasePath();
    const initial = yield* openJournal(databasePath);
    initial.database.run('DROP INDEX attachments_inbound_message');
    initial.database.run('UPDATE schema_meta SET version = 15');
    initial.close();

    const migrated = yield* openJournal(databasePath);
    const indexes = migrated.database
      .query<{ name: string }, []>("PRAGMA index_list('attachments')")
      .all()
      .map(({ name }) => name);
    expect(indexes).toContain('attachments_inbound_message');
    expect(inspectJournal(databasePath).migrationVersion).toBe(16);
    migrated.close();
  }),
);

it.effect('uses the attachment index for the bounded pending-message join', () =>
  Effect.gen(function* explainRecoveryJoin() {
    const handle = yield* openJournal(makeDatabasePath());
    const plan = handle.database
      .query<{ detail: string }, [number, number]>(`EXPLAIN QUERY PLAN ${PENDING_INBOUND_QUERY}`)
      .all(0, 100)
      .map(({ detail }) => detail);
    expect(plan.some((detail) => detail.includes('attachments_inbound_message'))).toBe(true);
    handle.close();
  }),
);
