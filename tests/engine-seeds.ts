import type { Database } from 'bun:sqlite';

const seedActiveTurn = (database: Database): void => {
  const now = '2026-07-14T12:00:00.000Z';
  database.run(
    "INSERT INTO generations VALUES ('generation', 1, 'Current', ?, NULL, 'thread-1', NULL, NULL)",
    [now],
  );
  database.run(
    "INSERT INTO logical_turns VALUES ('logical-turn', 'generation', 1, 'Running', 'correlation', ?, NULL, NULL)",
    [now],
  );
  database.run(
    `INSERT INTO inbound_messages(
       id, message_guid, messages_rowid, chat_guid, handle, service, text, sent_at, observed_at
     ) VALUES (
       'inbound-initial', 'message-initial', 1000, 'any;-;+15555550199', '+15555550199',
       'iMessage', 'recovered request', ?, ?
     )`,
    [now, now],
  );
  database.run(
    `INSERT INTO input_batches(id, logical_turn_id, sequence, kind, fingerprint, created_at)
     VALUES ('batch-initial', 'logical-turn', 1, 'Initial', '["inbound-initial"]', ?)`,
    [now],
  );
  database.run(
    `INSERT INTO input_batch_messages(input_batch_id, inbound_message_id, ordinal)
     VALUES ('batch-initial', 'inbound-initial', 0)`,
  );
  database.run(
    `INSERT INTO scheduler_state(
      singleton, generation_id, active_logical_turn_id, active_codex_turn_id,
      active_acknowledged, timer_deadline_at, updated_at
    ) VALUES (1, 'generation', 'logical-turn', 'turn-1', 0, NULL, ?)`,
    [now],
  );
};

export { seedActiveTurn };
