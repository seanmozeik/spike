import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { Effect } from 'effect';

import { openJournal } from '../src/database';
import { attachmentInputTextSql } from '../src/journal/attachment-input';
import {
  ATTACHMENTS_INBOUND_MESSAGE_INDEX,
  PENDING_INBOUND_QUERY,
} from '../src/journal/recovery-query';

const MESSAGE_COUNT = 50_000;
const ATTACHMENTS_PER_MESSAGE = 3;
const QUERY_PASSES = 100;
const CREATED_AT = '2026-07-19T12:00:00.000Z';

const LEGACY_UNBOUNDED_QUERY = `SELECT im.id, im.text, im.observed_at,
       MAX(CASE WHEN a.state = 'Observed' THEN 1 ELSE 0 END) AS has_observed_attachment,
       ${attachmentInputTextSql} AS attachment_text
FROM inbound_messages im
LEFT JOIN attachments a ON a.inbound_message_id = im.id
WHERE NOT EXISTS (
  SELECT 1 FROM input_batch_messages ibm WHERE ibm.inbound_message_id = im.id
) AND NOT EXISTS (
  SELECT 1 FROM scheduler_pool_messages spm WHERE spm.inbound_message_id = im.id
) AND NOT EXISTS (
  SELECT 1 FROM handled_control_messages hcm WHERE hcm.inbound_message_id = im.id
) AND NOT EXISTS (
  SELECT 1 FROM handled_approval_messages ham WHERE ham.inbound_message_id = im.id
)
GROUP BY im.id, im.text, im.observed_at, im.messages_rowid
ORDER BY im.messages_rowid`;

const seedClaimedHistory = (database: Database): void => {
  const insertInbound = database.prepare(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (?, ?, ?, 'chat', 'handle', 'iMessage', 'claimed', ?, ?)`,
  );
  const insertAttachment = database.prepare(
    `INSERT INTO attachments(
       id, inbound_message_id, attachment_guid, state, filename, mime_type, ordinal, created_at
     ) VALUES (?, ?, ?, 'Staged', 'image.jpg', 'image/jpeg', ?, ?)`,
  );
  const insertClaim = database.prepare(
    "INSERT INTO input_batch_messages(input_batch_id, inbound_message_id, ordinal) VALUES ('batch', ?, ?)",
  );
  const seed = database.transaction(() => {
    database.run(
      `INSERT INTO generations(id, sequence, state, created_at)
       VALUES ('generation', 1, 'Current', ?)`,
      [CREATED_AT],
    );
    database.run(
      `INSERT INTO logical_turns(id, generation_id, sequence, state, correlation_id, created_at)
       VALUES ('turn', 'generation', 1, 'Completed', 'benchmark', ?)`,
      [CREATED_AT],
    );
    database.run(
      `INSERT INTO input_batches(id, logical_turn_id, sequence, kind, fingerprint, created_at)
       VALUES ('batch', 'turn', 1, 'Initial', 'benchmark', ?)`,
      [CREATED_AT],
    );
    for (let row = 1; row <= MESSAGE_COUNT; row += 1) {
      const inboundId = `inbound-${String(row)}`;
      insertInbound.run(inboundId, `message-${String(row)}`, row, CREATED_AT, CREATED_AT);
      for (let ordinal = 0; ordinal < ATTACHMENTS_PER_MESSAGE; ordinal += 1) {
        const attachmentId = `attachment-${String(row)}-${String(ordinal)}`;
        insertAttachment.run(attachmentId, inboundId, `guid-${attachmentId}`, ordinal, CREATED_AT);
      }
      insertClaim.run(inboundId, row - 1);
    }
  });
  seed.immediate();
};

const timeQueries = (run: () => unknown): number => {
  run();
  const started = performance.now();
  for (let pass = 0; pass < QUERY_PASSES; pass += 1) {
    run();
  }
  return performance.now() - started;
};

const round = (value: number): number => Number(value.toFixed(2));

const main = Effect.gen(function* benchmarkRecoveryQuery() {
  const root = mkdtempSync(path.join(tmpdir(), 'spike-recovery-benchmark-'));
  try {
    const journal = yield* openJournal(path.join(root, 'spike.db'));
    try {
      seedClaimedHistory(journal.database);
      journal.database.run('DROP INDEX attachments_inbound_message');
      const legacy = journal.database.query<unknown, []>(LEGACY_UNBOUNDED_QUERY);
      const legacyMs = timeQueries(() => legacy.all());

      journal.database.run(ATTACHMENTS_INBOUND_MESSAGE_INDEX);
      const bounded = journal.database.query<unknown, [number, number]>(PENDING_INBOUND_QUERY);
      const boundedMs = timeQueries(() => bounded.all(MESSAGE_COUNT, MESSAGE_COUNT));
      const improvement = legacyMs / boundedMs;
      const result = {
        attachments: MESSAGE_COUNT * ATTACHMENTS_PER_MESSAGE,
        boundedMs: round(boundedMs),
        improvement: round(improvement),
        legacyMs: round(legacyMs),
        messages: MESSAGE_COUNT,
        queryPasses: QUERY_PASSES,
      };
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (improvement < 10) {
        return yield* Effect.die(
          new Error(`bounded recovery query improved only ${improvement.toFixed(2)}x`),
        );
      }
    } finally {
      journal.close();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
  return yield* Effect.void;
});

await Effect.runPromise(main);
