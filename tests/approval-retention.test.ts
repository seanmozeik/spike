import type { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import {
  approvalRequest,
  CUTOFF,
  fileApprovalRequest,
  makeRetentionFixture,
  NOW,
  OLD,
} from './retention-fixture';

interface ApprovalPayloadRow {
  readonly available_decisions_json: null | string;
  readonly command_text: null | string;
  readonly connection_id: string;
  readonly cwd: null | string;
  readonly delivered_at: null | string;
  readonly delivery_attempted_at: null | string;
  readonly delivery_error: null | string;
  readonly expires_at: string;
  readonly file_paths_json: string;
  readonly id: string;
  readonly item_id: null | string;
  readonly logical_turn_id: null | string;
  readonly method: string;
  readonly operation: string;
  readonly params_json: string;
  readonly payload_redacted_at: null | string;
  readonly reason: null | string;
  readonly resolved_at: null | string;
  readonly resolving_inbound_message_id: null | string;
  readonly responded_at: null | string;
  readonly requested_at: string;
  readonly response_json: null | string;
  readonly rpc_request_id_json: string;
  readonly state: string;
  readonly thread_id: null | string;
  readonly turn_id: null | string;
}

const approvalRows = (database: Database): readonly ApprovalPayloadRow[] =>
  database
    .query<ApprovalPayloadRow, []>(
      `SELECT id, connection_id, rpc_request_id_json, method, thread_id, turn_id,
              logical_turn_id, item_id, operation, params_json,
              available_decisions_json, command_text, cwd, file_paths_json, reason, state,
              requested_at, expires_at, delivery_attempted_at, delivered_at, resolved_at,
              responded_at, resolving_inbound_message_id, response_json, delivery_error,
              payload_redacted_at
       FROM approval_requests ORDER BY rpc_request_id_json`,
    )
    .all();

const approvalAudit = (row: ApprovalPayloadRow): object => ({
  availableDecisions: row.available_decisions_json,
  connectionId: row.connection_id,
  deliveredAt: row.delivered_at,
  deliveryAttemptedAt: row.delivery_attempted_at,
  expiresAt: row.expires_at,
  id: row.id,
  itemId: row.item_id,
  logicalTurnId: row.logical_turn_id,
  method: row.method,
  operation: row.operation,
  requestedAt: row.requested_at,
  resolvedAt: row.resolved_at,
  resolvingInboundMessageId: row.resolving_inbound_message_id,
  respondedAt: row.responded_at,
  rpcRequestId: row.rpc_request_id_json,
  state: row.state,
  threadId: row.thread_id,
  turnId: row.turn_id,
});

it.effect('redacts terminal approval payloads and leaves Pending approvals intact', () =>
  Effect.gen(function* approvalRetention() {
    const fixture = yield* makeRetentionFixture();
    const command = yield* fixture.approvals.enqueue(approvalRequest(1, 'private command'), 'one');
    const patch = yield* fixture.approvals.enqueue(fileApprovalRequest(2), 'two');
    yield* fixture.approvals.enqueue(approvalRequest(3, 'active command'), 'three');
    yield* fixture.approvals.markDeliveryFailed(command.id, 'private command error', OLD);
    yield* fixture.approvals.markDeliveryFailed(patch.id, 'private patch error', OLD);
    const before = approvalRows(fixture.database);

    yield* fixture.journal.redactTerminalPayloads(CUTOFF, NOW);
    const after = approvalRows(fixture.database);
    expect(after.map((row) => approvalAudit(row))).toStrictEqual(
      before.map((row) => approvalAudit(row)),
    );
    expect(after.slice(0, 2)).toMatchObject([
      {
        command_text: null,
        cwd: null,
        delivery_error: null,
        file_paths_json: '[]',
        params_json: '{}',
        payload_redacted_at: NOW.toISOString(),
        reason: null,
        response_json: null,
      },
      {
        command_text: null,
        cwd: null,
        delivery_error: null,
        file_paths_json: '[]',
        params_json: '{}',
        payload_redacted_at: NOW.toISOString(),
        reason: null,
        response_json: null,
      },
    ]);
    expect(after[2]).toStrictEqual(before[2]);
    expect(before[1]?.file_paths_json).toContain('/private/workspace/secret.ts');
    fixture.close();
  }),
);
