import { Database } from 'bun:sqlite';

import { Effect } from 'effect';

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

interface MessagesTransport {
  readonly close: () => void;
  readonly findMatchingAfter: (
    frontierRowId: number,
    text: string,
  ) => Effect.Effect<DeliveryReceipt | null, MessagesDeliveryError>;
  readonly frontier: Effect.Effect<number, MessagesDeliveryError>;
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

const makeMessagesTransport = (
  database: Database,
  chatGuid: string,
  sendBoundary: SendBoundary = sendTextBoundary,
): MessagesTransport => ({
  close: (): void => {
    database.close();
  },
  findMatchingAfter: (
    frontierRowId,
    text,
  ): Effect.Effect<DeliveryReceipt | null, MessagesDeliveryError> =>
    Effect.try({
      catch: (cause) => deliveryError('reconcile', cause),
      try: (): DeliveryReceipt | null => findMatching(database, chatGuid, frontierRowId, text),
    }),
  frontier: Effect.try({
    catch: (cause) => deliveryError('frontier', cause),
    try: (): number => readFrontier(database, chatGuid),
  }),
  send: (text): Effect.Effect<void, MessagesDeliveryError> =>
    sendBoundary(chatGuid, text).pipe(Effect.mapError((cause) => deliveryError('send', cause))),
});

const openMessagesTransport = (
  databasePath: string,
  chatGuid: string,
): Effect.Effect<MessagesTransport, MessagesDeliveryError> =>
  Effect.try({
    catch: (cause) => deliveryError('open', cause),
    try: () => {
      const database = new Database(databasePath, { readonly: true, strict: true });
      try {
        database.query('SELECT ROWID FROM message LIMIT 1').get();
        return makeMessagesTransport(database, chatGuid);
      } catch (error) {
        database.close();
        throw error;
      }
    },
  });

export { makeMessagesTransport, normalizeText, openMessagesTransport, textsMatch };
export type { DeliveryReceipt, MessagesTransport };
