import type { Database } from 'bun:sqlite';

import { ConversationMismatchError } from './errors';

interface ConfiguredMessagesConversation {
  readonly chatGuid: string;
  readonly handle: string;
}

interface ChatRow {
  readonly canonical_participant_count: number;
  readonly chat_identifier: string;
  readonly guid: string;
  readonly imessage_participant_count: number;
  readonly participant_count: number;
  readonly service_name: string;
  readonly style: number;
}

const DIRECT_CHAT_STYLE = 45;
const CHAT_QUERY = `SELECT c.guid, c.style, c.chat_identifier, c.service_name,
  COUNT(chj.handle_id) AS participant_count,
  SUM(CASE WHEN lower(h.id) = lower(?) THEN 1 ELSE 0 END) AS canonical_participant_count,
  SUM(CASE WHEN h.service = 'iMessage' THEN 1 ELSE 0 END) AS imessage_participant_count
  FROM chat c
  LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
  LEFT JOIN handle h ON h.ROWID = chj.handle_id
  WHERE c.guid = ?
  GROUP BY c.ROWID`;

const validateConfiguredConversation = (
  database: Database,
  conversation: ConfiguredMessagesConversation,
): void => {
  const chat = database
    .query<ChatRow, [string, string]>(CHAT_QUERY)
    .get(conversation.handle, conversation.chatGuid);
  if (
    chat?.style === DIRECT_CHAT_STYLE &&
    chat.service_name === 'iMessage' &&
    chat.chat_identifier.toLowerCase() === conversation.handle.toLowerCase() &&
    chat.participant_count === 1 &&
    chat.canonical_participant_count === 1 &&
    chat.imessage_participant_count === 1
  ) {
    return;
  }
  throw new ConversationMismatchError({
    chatGuid: conversation.chatGuid,
    handle: conversation.handle,
    message:
      'configured chat must remain the exact one-to-one iMessage chat containing the canonical handle',
  });
};

export { validateConfiguredConversation };
export type { ConfiguredMessagesConversation };
