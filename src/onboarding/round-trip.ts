import { Database } from 'bun:sqlite';

import type { ConversationCandidate } from './types';

interface RoundTripRow {
  readonly inbound_rowid: number;
  readonly outbound_rowid: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 500;

const ROUND_TRIP_QUERY = `SELECT inbound.ROWID AS inbound_rowid, outbound.ROWID AS outbound_rowid
  FROM message inbound
  JOIN chat_message_join inbound_join ON inbound_join.message_id = inbound.ROWID
  JOIN chat c ON c.ROWID = inbound_join.chat_id
  JOIN handle h ON h.ROWID = inbound.handle_id
  JOIN message outbound ON outbound.ROWID > inbound.ROWID AND outbound.is_from_me = 1
  JOIN chat_message_join outbound_join
    ON outbound_join.message_id = outbound.ROWID AND outbound_join.chat_id = c.ROWID
  WHERE c.guid = ? AND lower(h.id) = lower(?)
    AND inbound.is_from_me = 0 AND inbound.service = 'iMessage'
    AND ((inbound.date / 1000000.0) + 978307200000.0) >= ?
  ORDER BY outbound.ROWID DESC LIMIT 1`;

const observeRoundTrip = (
  databasePath: string,
  conversation: ConversationCandidate,
  startedAt: Date,
): boolean => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return (
      database
        .query<RoundTripRow, [string, string, number]>(ROUND_TRIP_QUERY)
        .get(conversation.chatGuid, conversation.handle, startedAt.getTime()) !== null
    );
  } finally {
    database.close();
  }
};

const waitForRoundTrip = async (
  databasePath: string,
  conversation: ConversationCandidate,
  startedAt: Date,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (observeRoundTrip(databasePath, conversation, startedAt)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for Spike’s first real iMessage reply');
    }
    await Bun.sleep(POLL_INTERVAL_MS);
    await poll();
  };
  await poll();
};

export { observeRoundTrip, waitForRoundTrip };
