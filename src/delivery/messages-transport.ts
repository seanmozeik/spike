import type { Database } from 'bun:sqlite';

import { Effect } from 'effect';

import type { ConversationAvailability } from '../conversation-policy';
import type { ConfiguredMessagesConversation } from '../messages-conversation';
import { openValidatedMessagesDatabase } from '../messages-database';
import { decodeAttributedBody } from '../messages-inbox';
import { MessagesDeliveryError } from './error';
import { makeOsascriptSendBoundary, type SendBoundary } from './osascript-send';

interface DeliveryReceipt {
  readonly guid: string;
  readonly rowId: number;
}

interface OutboundRow {
  readonly attributedBody: null | Uint8Array;
  readonly guid: string;
  readonly rowid: number;
  readonly text: null | string;
}

interface TransportState {
  closed: boolean;
  database: Database;
}

interface MessagesTransportOptions {
  readonly chatGuid: string;
  readonly database: Database;
  readonly reopen?: () => Database;
  readonly sendBoundary: SendBoundary;
}

interface MessagesTransport {
  readonly close: () => void;
  readonly findMatchingAfter: (
    frontierRowId: number,
    text: string,
  ) => Effect.Effect<DeliveryReceipt | null, MessagesDeliveryError>;
  readonly frontier: Effect.Effect<number, MessagesDeliveryError>;
  readonly refresh: Effect.Effect<void, MessagesDeliveryError>;
  readonly send: (text: string) => Effect.Effect<void, MessagesDeliveryError>;
}

const deliveryError = (operation: string, cause: unknown): MessagesDeliveryError =>
  new MessagesDeliveryError({
    cause,
    message: `Messages delivery failed: ${operation}`,
    operation,
  });

const ATTRIBUTED_BODY_PREFIX = String.fromCodePoint(1);

const normalizeText = (text: string): string =>
  text
    .replaceAll(ATTRIBUTED_BODY_PREFIX, ' ')
    .replaceAll('\u200D', '')
    .replaceAll(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replaceAll(/[\u2018\u2019]/gu, "'")
    .replaceAll(/[\u201C\u201D]/gu, '"')
    .replaceAll(/\uFFFD+$/gu, '')
    .trim()
    .replaceAll(/\s+/gu, ' ');

const MINIMUM_ATTRIBUTED_PREFIX = 12;

const textsMatch = (actual: string, expected: string): boolean => {
  const normalizedActual = normalizeText(actual);
  const normalizedExpected = normalizeText(expected);
  return (
    normalizedActual === normalizedExpected ||
    (normalizedActual.length >= MINIMUM_ATTRIBUTED_PREFIX &&
      normalizedExpected.startsWith(normalizedActual))
  );
};

const rowText = (row: OutboundRow): string =>
  row.text ?? (row.attributedBody === null ? '' : (decodeAttributedBody(row.attributedBody) ?? ''));

const findMatching = (
  database: Database,
  chatGuid: string,
  frontierRowId: number,
  text: string,
): DeliveryReceipt | null => {
  const rows = database
    .query<OutboundRow, [string, number]>(
      `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       WHERE c.guid = ? AND m.ROWID > ? AND m.is_from_me = 1 AND m.service = 'iMessage'
       ORDER BY m.ROWID ASC`,
    )
    .all(chatGuid, frontierRowId);
  const match = rows.find((row) => textsMatch(rowText(row), text));
  return match === undefined ? null : { guid: match.guid, rowId: match.rowid };
};

const readFrontier = (database: Database, chatGuid: string): number =>
  database
    .query<{ rowid: null | number }, [string]>(
      `SELECT MAX(m.ROWID) AS rowid
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id WHERE c.guid = ?`,
    )
    .get(chatGuid)?.rowid ?? 0;

const sendTextBoundary = makeOsascriptSendBoundary();

const makeRefresh = (
  state: TransportState,
  reopen: (() => Database) | undefined,
): Effect.Effect<void, MessagesDeliveryError> => {
  if (reopen === undefined) {
    return Effect.void;
  }
  return Effect.try({
    catch: (cause) => deliveryError('refresh', cause),
    try: () => {
      if (state.closed) {
        throw new Error('Messages transport is closed');
      }
      const replacement = reopen();
      try {
        state.database.close();
        state.database = replacement;
      } catch (error) {
        replacement.close();
        throw error;
      }
    },
  });
};

const makeTransport = ({
  chatGuid,
  database,
  reopen,
  sendBoundary,
}: MessagesTransportOptions): MessagesTransport => {
  const state: TransportState = { closed: false, database };
  return {
    close: (): void => {
      if (state.closed) {
        return;
      }
      state.closed = true;
      state.database.close();
    },
    findMatchingAfter: (
      frontierRowId,
      text,
    ): Effect.Effect<DeliveryReceipt | null, MessagesDeliveryError> =>
      Effect.try({
        catch: (cause) => deliveryError('reconcile', cause),
        try: (): DeliveryReceipt | null =>
          findMatching(state.database, chatGuid, frontierRowId, text),
      }),
    frontier: Effect.try({
      catch: (cause) => deliveryError('frontier', cause),
      try: (): number => readFrontier(state.database, chatGuid),
    }),
    refresh: makeRefresh(state, reopen),
    send: (text): Effect.Effect<void, MessagesDeliveryError> =>
      sendBoundary(chatGuid, text).pipe(Effect.mapError((cause) => deliveryError('send', cause))),
  };
};

const makeMessagesTransport = (
  database: Database,
  chatGuid: string,
  sendBoundary: SendBoundary = sendTextBoundary,
): MessagesTransport => makeTransport({ chatGuid, database, sendBoundary });

const withConversationAvailability = (
  transport: MessagesTransport,
  availability: ConversationAvailability,
): MessagesTransport => {
  const wait = <A>(
    effect: Effect.Effect<A, MessagesDeliveryError>,
  ): Effect.Effect<A, MessagesDeliveryError> =>
    availability.awaitAvailable.pipe(Effect.andThen(effect));
  return {
    close: transport.close,
    findMatchingAfter: (frontierRowId, text) =>
      wait(transport.findMatchingAfter(frontierRowId, text)),
    frontier: wait(transport.frontier),
    refresh: transport.refresh,
    send: (text) => wait(transport.send(text)),
  };
};

const openMessagesTransport = (
  databasePath: string,
  conversation: ConfiguredMessagesConversation,
): Effect.Effect<MessagesTransport, MessagesDeliveryError> =>
  Effect.try({
    catch: (cause) => deliveryError('open', cause),
    try: () =>
      makeTransport({
        chatGuid: conversation.chatGuid,
        database: openValidatedMessagesDatabase({ databasePath, ...conversation }),
        reopen: () => openValidatedMessagesDatabase({ databasePath, ...conversation }),
        sendBoundary: sendTextBoundary,
      }),
  });

export {
  makeMessagesTransport,
  normalizeText,
  openMessagesTransport,
  textsMatch,
  withConversationAvailability,
};
export type { DeliveryReceipt, MessagesTransport };
