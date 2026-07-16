import { Database } from 'bun:sqlite';

import type { ConversationCandidate } from './types';

interface CandidateRow {
  readonly chat_guid: string;
  readonly handle: string;
  readonly last_message_unix_ms: null | number;
}

class ConversationDiscoveryError extends Error {
  readonly kind: 'permission' | 'query';

  constructor(kind: 'permission' | 'query', cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ConversationDiscoveryError';
    this.kind = kind;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const E164 = /^\+[1-9]\d{7,14}$/u;

const normalizePeerHandle = (input: string): string => {
  const trimmed = input.trim();
  if (EMAIL.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const phone = trimmed.replaceAll(/[\s().-]/gu, '');
  if (E164.test(phone)) {
    return phone;
  }
  throw new Error('Enter an E.164 phone number such as +447700900123 or an iMessage email');
};

const CANDIDATES_QUERY = `SELECT c.guid AS chat_guid, h.id AS handle,
  MAX((m.date / 1000000.0) + 978307200000.0) AS last_message_unix_ms
  FROM handle h
  JOIN chat_handle_join target ON target.handle_id = h.ROWID
  JOIN chat c ON c.ROWID = target.chat_id
  LEFT JOIN chat_handle_join participants ON participants.chat_id = c.ROWID
  LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
  LEFT JOIN message m ON m.ROWID = cmj.message_id
  WHERE lower(h.id) = lower(?) AND c.style = 45
  GROUP BY c.ROWID, h.ROWID
  HAVING COUNT(DISTINCT participants.handle_id) = 1
  ORDER BY last_message_unix_ms DESC`;

const discoverDirectConversations = (
  databasePath: string,
  handle: string,
): readonly ConversationCandidate[] => {
  let database: Database;
  try {
    database = new Database(databasePath, { readonly: true, strict: true });
  } catch (error) {
    throw new ConversationDiscoveryError('permission', error);
  }
  try {
    return database
      .query<CandidateRow, [string]>(CANDIDATES_QUERY)
      .all(handle)
      .map((row) => ({
        chatGuid: row.chat_guid,
        handle: normalizePeerHandle(row.handle),
        lastMessageAt:
          row.last_message_unix_ms === null ? null : new Date(row.last_message_unix_ms),
      }));
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error);
    const kind = /authoriz|permission|unable to open/u.test(message) ? 'permission' : 'query';
    throw new ConversationDiscoveryError(kind, error);
  } finally {
    database.close();
  }
};

export { ConversationDiscoveryError, discoverDirectConversations, normalizePeerHandle };
