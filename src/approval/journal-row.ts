import type { Database } from 'bun:sqlite';

import { Schema } from 'effect';

import { ApprovalId } from '../domain/ids';
import type { ApprovalRecord } from './journal-types';
import { ApprovalMethod, type ApprovalRequest, type ApprovalState } from './model';

interface ApprovalRow {
  readonly available_decisions_json: null | string;
  readonly command_text: null | string;
  readonly connection_id: string;
  readonly cwd: null | string;
  readonly delivered_at: null | string;
  readonly expires_at: string;
  readonly file_paths_json: string;
  readonly id: string;
  readonly item_id: null | string;
  readonly method: string;
  readonly operation: ApprovalRequest['operation'];
  readonly params_json: string;
  readonly reason: null | string;
  readonly requested_at: string;
  readonly response_json: null | string;
  readonly rpc_request_id_json: string;
  readonly state: ApprovalState;
  readonly thread_id: null | string;
  readonly turn_id: null | string;
}

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;
const decodeStrings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const decodeRpcId = Schema.decodeUnknownSync(Schema.Union([Schema.String, Schema.Finite]));

const parseRow = (row: ApprovalRow): ApprovalRecord => ({
  availableDecisions:
    row.available_decisions_json === null
      ? null
      : Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
          parseJson(row.available_decisions_json),
        ),
  command: row.command_text,
  connectionId: row.connection_id,
  cwd: row.cwd,
  deliveredAt: row.delivered_at === null ? null : new Date(row.delivered_at),
  expiresAt: new Date(row.expires_at),
  filePaths: decodeStrings(parseJson(row.file_paths_json)),
  id: ApprovalId.make(row.id),
  itemId: row.item_id,
  method: Schema.decodeUnknownSync(ApprovalMethod)(row.method),
  operation: row.operation,
  params: parseJson(row.params_json),
  reason: row.reason,
  requestedAt: new Date(row.requested_at),
  response: row.response_json === null ? null : parseJson(row.response_json),
  rpcRequestId: decodeRpcId(parseJson(row.rpc_request_id_json)),
  state: row.state,
  threadId: row.thread_id,
  turnId: row.turn_id,
});

const selectById = (database: Database, id: ApprovalId): ApprovalRecord | null => {
  const row = database
    .query<ApprovalRow, [string]>('SELECT * FROM approval_requests WHERE id = ?')
    .get(id);
  return row === null ? null : parseRow(row);
};

export { parseRow, selectById };
export type { ApprovalRow };
