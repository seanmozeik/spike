import type { Database } from 'bun:sqlite';

import { makeOutageDiagnostic, type OutageDiagnostic } from './outage-diagnostic';

type ConversationDiagnostic = OutageDiagnostic;

const EPISODE_KIND = 'MessagesConversationBoundaryInvalid';
const DIAGNOSTIC_MESSAGE =
  'Configured Messages conversation no longer matches its trusted direct iMessage boundary';

const makeConversationDiagnostic = (database: Database): ConversationDiagnostic =>
  makeOutageDiagnostic(database, {
    errorTag: 'ConversationBoundaryInvalid',
    kind: EPISODE_KIND,
    message: DIAGNOSTIC_MESSAGE,
    operation: 'messages-conversation-validation',
  });

export { DIAGNOSTIC_MESSAGE, EPISODE_KIND, makeConversationDiagnostic };
export type { ConversationDiagnostic };
