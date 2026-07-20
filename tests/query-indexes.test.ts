import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { inspectJournal, openJournal } from '../src/database';
import { SCHEMA_VERSION } from '../src/journal/migrations';

interface QueryPlanRow {
  readonly detail: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const makeDatabasePath = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-query-indexes-'));
  roots.push(root);
  return path.join(root, 'spike.db');
};

const usesIndex = (plan: readonly QueryPlanRow[], index: string): boolean =>
  plan.some(({ detail }) => detail.includes(index));

const sortsWithTemporaryTree = (plan: readonly QueryPlanRow[]): boolean =>
  plan.some(({ detail }) => detail.includes('USE TEMP B-TREE FOR ORDER BY'));

it.effect('migrates schema v18 query indexes without leaving the old definitions', () =>
  Effect.gen(function* migrateQueryIndexes() {
    const databasePath = makeDatabasePath();
    const initial = yield* openJournal(databasePath);
    initial.database.run('DROP INDEX attachments_inbound_message');
    initial.database.run(
      'CREATE INDEX attachments_inbound_message ON attachments(inbound_message_id)',
    );
    initial.database.run('DROP INDEX schedules_due');
    initial.database.run('CREATE INDEX schedules_due ON schedules(state, next_due_at)');
    initial.database.run('DROP INDEX account_observations_latest');
    initial.database.run('DROP INDEX account_observations_retention');
    initial.database.run('DROP INDEX approval_pending_requested');
    initial.database.run('DROP INDEX approval_pending_fifo');
    initial.database.run(
      'CREATE INDEX approval_pending_fifo ON approval_requests(state, delivered_at, requested_at)',
    );
    initial.database.run('DROP INDEX failures_retention');
    initial.database.run('DROP INDEX outbound_recoverable');
    initial.database.run('UPDATE schema_meta SET version = 18');
    initial.close();

    const migrated = yield* openJournal(databasePath);
    const indexes = new Map(
      migrated.database
        .query<{ name: string; sql: string }, []>(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
        )
        .all()
        .map(({ name, sql }) => [name, sql.replaceAll(/\s+/gu, ' ')]),
    );
    expect(indexes.get('attachments_inbound_message')).toContain(
      'attachments(inbound_message_id, ordinal, id)',
    );
    expect(indexes.get('schedules_due')).toContain('schedules(state, next_due_at, created_at)');
    for (const index of [
      'account_observations_latest',
      'account_observations_retention',
      'approval_pending_fifo',
      'approval_pending_requested',
      'failures_retention',
      'outbound_recoverable',
    ]) {
      expect(indexes.has(index), `${index} should exist`).toBe(true);
    }
    expect(inspectJournal(databasePath).migrationVersion).toBe(SCHEMA_VERSION);
    migrated.close();
  }),
);

it.effect('plans hot ordered reads without table scans or temporary sorts', () =>
  Effect.gen(function* explainHotReads() {
    const handle = yield* openJournal(makeDatabasePath());

    const accountPlan = handle.database
      .query<QueryPlanRow, [string]>(
        `EXPLAIN QUERY PLAN SELECT account_id FROM account_observations
         WHERE account_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .all('account');
    expect(usesIndex(accountPlan, 'account_observations_latest')).toBe(true);

    const attachmentPlan = handle.database
      .query<QueryPlanRow, [string]>(
        `EXPLAIN QUERY PLAN SELECT id FROM attachments
         WHERE inbound_message_id = ? ORDER BY ordinal, id`,
      )
      .all('message');
    expect(usesIndex(attachmentPlan, 'attachments_inbound_message')).toBe(true);
    expect(sortsWithTemporaryTree(attachmentPlan)).toBe(false);

    const approvalPlan = handle.database
      .query<QueryPlanRow, []>(
        `EXPLAIN QUERY PLAN SELECT id FROM approval_requests
         WHERE state = 'Pending' ORDER BY requested_at LIMIT 1`,
      )
      .all();
    expect(usesIndex(approvalPlan, 'approval_pending_requested')).toBe(true);
    expect(sortsWithTemporaryTree(approvalPlan)).toBe(false);

    const displayedApprovalPlan = handle.database
      .query<QueryPlanRow, []>(
        `EXPLAIN QUERY PLAN SELECT id FROM approval_requests
         WHERE state = 'Pending' AND delivered_at IS NOT NULL LIMIT 1`,
      )
      .all();
    expect(usesIndex(displayedApprovalPlan, 'approval_pending_fifo')).toBe(true);

    const outboundPlan = handle.database
      .query<QueryPlanRow, []>(
        `EXPLAIN QUERY PLAN SELECT id FROM outbound_messages
         WHERE state IN ('Prepared','Delivering') ORDER BY created_at`,
      )
      .all();
    expect(usesIndex(outboundPlan, 'outbound_recoverable')).toBe(true);
    expect(sortsWithTemporaryTree(outboundPlan)).toBe(false);

    const schedulePlan = handle.database
      .query<QueryPlanRow, [string]>(
        `EXPLAIN QUERY PLAN SELECT id FROM schedules
         WHERE state = 'Active' AND next_due_at <= ?
         ORDER BY next_due_at, created_at LIMIT 1`,
      )
      .all('2099-01-01T00:00:00.000Z');
    expect(usesIndex(schedulePlan, 'schedules_due')).toBe(true);
    expect(sortsWithTemporaryTree(schedulePlan)).toBe(false);

    handle.close();
  }),
);

it.effect('plans retention pruning through cutoff indexes', () =>
  Effect.gen(function* explainRetentionPruning() {
    const handle = yield* openJournal(makeDatabasePath());
    const failurePlan = handle.database
      .query<QueryPlanRow, [string]>('EXPLAIN QUERY PLAN DELETE FROM failures WHERE created_at < ?')
      .all('2099-01-01T00:00:00.000Z');
    expect(usesIndex(failurePlan, 'failures_retention')).toBe(true);

    const observationPlan = handle.database
      .query<QueryPlanRow, [string]>(
        'EXPLAIN QUERY PLAN DELETE FROM account_observations WHERE observed_at < ?',
      )
      .all('2099-01-01T00:00:00.000Z');
    expect(usesIndex(observationPlan, 'account_observations_retention')).toBe(true);
    handle.close();
  }),
);
