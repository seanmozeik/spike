import type { Database } from 'bun:sqlite';

import { counts, listCommands, listRecent, nextUndelivered } from './journal-read';
import {
  cancelConnection,
  expireDue,
  markOrphaned,
  orphanConnection,
  resolveCommand,
  resolveUpstream,
} from './journal-resolve';
import type { ApprovalJournal } from './journal-types';
import {
  enqueue,
  markDelivered,
  markDeliveryFailed,
  markResponded,
  markResponseFailed,
} from './journal-write';

const makeApprovalJournal = (database: Database): ApprovalJournal => ({
  cancelConnection: (connectionId, at): ReturnType<ApprovalJournal['cancelConnection']> =>
    cancelConnection(database, connectionId, at),
  counts: (now): ReturnType<ApprovalJournal['counts']> => counts(database, now),
  enqueue: (request, connectionId): ReturnType<ApprovalJournal['enqueue']> =>
    enqueue(database, request, connectionId),
  expireDue: (now): ReturnType<ApprovalJournal['expireDue']> => expireDue(database, now),
  listCommands: listCommands(database),
  listRecent: (limit): ReturnType<ApprovalJournal['listRecent']> => listRecent(database, limit),
  markDelivered: (id, at): ReturnType<ApprovalJournal['markDelivered']> =>
    markDelivered(database, id, at),
  markDeliveryFailed: (id, error, at): ReturnType<ApprovalJournal['markDeliveryFailed']> =>
    markDeliveryFailed(database, id, error, at),
  markOrphaned: (connectionId, at): ReturnType<ApprovalJournal['markOrphaned']> =>
    markOrphaned(database, connectionId, at),
  markResponded: (id, at): ReturnType<ApprovalJournal['markResponded']> =>
    markResponded(database, id, at),
  markResponseFailed: (id, error, at): ReturnType<ApprovalJournal['markResponseFailed']> =>
    markResponseFailed(database, id, error, at),
  nextUndelivered: nextUndelivered(database),
  orphanConnection: (connectionId, at): ReturnType<ApprovalJournal['orphanConnection']> =>
    orphanConnection(database, connectionId, at),
  resolveCommand: (command, at): ReturnType<ApprovalJournal['resolveCommand']> =>
    resolveCommand(database, command, at),
  resolveUpstream: (
    connectionId,
    rpcRequestId,
    at,
  ): ReturnType<ApprovalJournal['resolveUpstream']> =>
    resolveUpstream(database, connectionId, rpcRequestId, at),
});

export { makeApprovalJournal };
export type {
  ApprovalCommand,
  ApprovalCounts,
  ApprovalJournal,
  ApprovalRecord,
  CommandResolution,
} from './journal-types';
