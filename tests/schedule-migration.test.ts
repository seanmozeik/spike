import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { openJournal } from '../src/database';
import { PENDING_INBOUND_QUERY } from '../src/journal/recovery-query';
import { needsDurableScheduleInboundRebuild } from '../src/journal/versioned-migrations';
import {
  assertVersionSixteenFixture,
  databaseNames,
  makePopulatedVersionSixteen,
  SCHEMA_VERSION_SEVENTEEN,
  schemaVersion,
} from './schedule-migration-fixture';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const makeDatabasePath = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-schedule-v16-'));
  roots.push(root);
  return path.join(root, 'spike.db');
};

it('limits the inbound identity rebuild to pre-v17 journals', () => {
  expect(needsDurableScheduleInboundRebuild(0)).toBe(false);
  expect(needsDurableScheduleInboundRebuild(16)).toBe(true);
  expect(needsDurableScheduleInboundRebuild(17)).toBe(false);
  expect(needsDurableScheduleInboundRebuild(18)).toBe(false);
});

it.effect(
  'migrates a populated schema-v16 journal to durable schedules without losing identity or recovery state',
  () =>
    Effect.gen(function* migrateDurableSchedules() {
      const databasePath = makeDatabasePath();
      const bootstrap = yield* openJournal(databasePath);
      bootstrap.close();
      makePopulatedVersionSixteen(databasePath);
      assertVersionSixteenFixture(databasePath);

      const migrated = yield* openJournal(databasePath);
      try {
        expect(schemaVersion(migrated.database)).toBe(SCHEMA_VERSION_SEVENTEEN);
        expect(
          migrated.database
            .query<
              {
                id: string;
                message_guid: string;
                messages_rowid: number;
                service: string;
                source_id: string;
                source_kind: string;
              },
              []
            >(
              `SELECT id, source_kind, source_id, message_guid, messages_rowid, service
               FROM inbound_messages ORDER BY messages_rowid`,
            )
            .all(),
        ).toStrictEqual([
          {
            id: 'batched-message',
            message_guid: 'guid-batched',
            messages_rowid: 10,
            service: 'iMessage',
            source_id: 'guid-batched',
            source_kind: 'Messages',
          },
          {
            id: 'pooled-message',
            message_guid: 'guid-pooled',
            messages_rowid: 20,
            service: 'iMessage',
            source_id: 'guid-pooled',
            source_kind: 'Messages',
          },
          {
            id: 'pending-message',
            message_guid: 'guid-pending',
            messages_rowid: 30,
            service: 'iMessage',
            source_id: 'guid-pending',
            source_kind: 'Messages',
          },
        ]);

        expect(
          databaseNames(
            migrated.database,
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name IN ('schedules', 'scheduled_runs', 'schedule_tool_calls')
             ORDER BY name`,
          ),
        ).toStrictEqual(['schedule_tool_calls', 'scheduled_runs', 'schedules']);
        expect(databaseNames(migrated.database, "PRAGMA index_list('schedules')")).toContain(
          'schedules_due',
        );
        expect(databaseNames(migrated.database, "PRAGMA index_list('scheduled_runs')")).toContain(
          'scheduled_runs_state',
        );
        expect(databaseNames(migrated.database, "PRAGMA index_list('inbound_messages')")).toEqual(
          expect.arrayContaining([
            'inbound_messages_message_guid',
            'inbound_messages_messages_rowid',
            'inbound_messages_source',
          ]),
        );
        expect(databaseNames(migrated.database, "PRAGMA index_list('attachments')")).toContain(
          'attachments_inbound_message',
        );

        expect(
          migrated.database
            .query<
              {
                content_hash: string;
                failure_code: null;
                id: string;
                ordinal: number;
                staged_path: string;
                state: string;
              },
              []
            >(
              `SELECT id, state, staged_path, content_hash, failure_code, ordinal
               FROM attachments WHERE id = 'staged-attachment'`,
            )
            .get(),
        ).toStrictEqual({
          content_hash: 'sha256-staged',
          failure_code: null,
          id: 'staged-attachment',
          ordinal: 0,
          staged_path: '/private/staged/active.png',
          state: 'Staged',
        });
        expect(
          migrated.database
            .query<
              {
                mode: string;
                reset_at: string;
                selected_at: string;
                usage_json: string;
                usable: number;
              },
              []
            >(
              `SELECT usable, mode, usage_json, reset_at, selected_at
               FROM account_observations WHERE account_id = 'account-v16'`,
            )
            .get(),
        ).toStrictEqual({
          mode: 'Capacity',
          reset_at: '2026-07-19T09:00:00.000Z',
          selected_at: '2026-07-19T07:59:00.000Z',
          usable: 0,
          usage_json: '{"remaining":0}',
        });
        expect(
          migrated.database
            .query<
              {
                active_codex_turn_id: string;
                active_logical_turn_id: string;
                generation_id: string;
              },
              []
            >(
              `SELECT generation_id, active_logical_turn_id, active_codex_turn_id
               FROM scheduler_state WHERE singleton = 1`,
            )
            .get(),
        ).toStrictEqual({
          active_codex_turn_id: 'turn-v16',
          active_logical_turn_id: 'logical-v16',
          generation_id: 'generation-v16',
        });
        expect(
          migrated.database
            .query<{ inbound_message_id: string; input_batch_id: string }, []>(
              'SELECT input_batch_id, inbound_message_id FROM input_batch_messages',
            )
            .all(),
        ).toStrictEqual([{ inbound_message_id: 'batched-message', input_batch_id: 'batch-v16' }]);
        expect(
          migrated.database
            .query<{ inbound_message_id: string; ordinal: number }, []>(
              'SELECT inbound_message_id, ordinal FROM scheduler_pool_messages',
            )
            .all(),
        ).toStrictEqual([{ inbound_message_id: 'pooled-message', ordinal: 0 }]);

        const pending = migrated.database
          .query<{ has_observed_attachment: number; id: string; text: string }, [number, number]>(
            PENDING_INBOUND_QUERY,
          )
          .all(0, 100);
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          has_observed_attachment: 1,
          id: 'pending-message',
          text: 'pending request',
        });
        const recoveryPlan = migrated.database
          .query<{ detail: string }, [number, number]>(
            `EXPLAIN QUERY PLAN ${PENDING_INBOUND_QUERY}`,
          )
          .all(0, 100)
          .map(({ detail }) => detail);
        expect(recoveryPlan.some((detail) => detail.includes('attachments_inbound_message'))).toBe(
          true,
        );
        expect(
          migrated.database.query<unknown, []>('PRAGMA foreign_key_check').all(),
        ).toStrictEqual([]);
      } finally {
        migrated.close();
      }
    }),
);
