import type { Database } from 'bun:sqlite';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import type { CodexServerRequest } from '../src/codex/server-request-registry';
import { ChatGuid, MessageGuid, MessagesRowId } from '../src/domain/ids';
import type { ObservedMessage } from '../src/domain/inbound';
import { ConversationMismatchError } from '../src/errors';
import { makeEngineFixture, settle } from './engine-fixture';

const inbound = (rowId: number, text: string): ObservedMessage => ({
  attachments: [],
  chatGuid: ChatGuid.make('any;-;+15555550199'),
  handle: '+15555550199',
  isFromMe: false,
  messageGuid: MessageGuid.make(`message-${String(rowId)}`),
  rowId: MessagesRowId.make(rowId),
  sentAt: new Date('2026-07-14T12:00:00.000Z'),
  service: 'iMessage',
  text,
});

const commandRequest = (id: number, command: string): CodexServerRequest => ({
  id,
  method: 'item/commandExecution/requestApproval',
  params: {
    availableDecisions: ['accept', 'decline'],
    command,
    cwd: '/workspace',
    itemId: `item-${String(id)}`,
    reason: 'needs network',
    startedAtMs: Date.parse('2026-07-14T12:00:00.000Z'),
    threadId: 'thread-1',
    turnId: 'turn-1',
  },
});

const stateOf = (database: Database, rpcId: number): string | null =>
  database
    .query<{ state: string }, [string]>(
      'SELECT state FROM approval_requests WHERE rpc_request_id_json = ?',
    )
    .get(JSON.stringify(rpcId))?.state ?? null;

it.effect('persists, prompts, consumes /yes, and returns the current command response', () =>
  Effect.gen(function* approveCommand() {
    const fixture = yield* makeEngineFixture();
    fixture.requestApproval(commandRequest(1, 'curl https://example.com'));
    yield* settle(fixture.engine);
    expect(fixture.sent[0]).toContain('Permission requested: Command');
    expect(fixture.sent[0]).toContain('curl https://example.com');
    expect(stateOf(fixture.database, 1)).toBe('Pending');

    fixture.push(inbound(1, '/yes'));
    yield* settle(fixture.engine);
    expect(fixture.responses).toStrictEqual([{ id: 1, result: { decision: 'accept' } }]);
    expect(stateOf(fixture.database, 1)).toBe('Approved');
    expect(fixture.inputs).toStrictEqual([]);
    expect(fixture.likes).toStrictEqual([]);
    expect(fixture.sent).toContain('Approved');
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('shows one prompt at a time and does not spill a second reply onto the queue', () =>
  Effect.gen(function* serializeApprovals() {
    const fixture = yield* makeEngineFixture();
    fixture.requestApproval(commandRequest(1, 'first-command'));
    fixture.requestApproval(commandRequest(2, 'second-command'));
    yield* settle(fixture.engine);
    expect(fixture.sent.filter((text) => text.startsWith('Permission requested:'))).toHaveLength(1);

    fixture.push(inbound(1, '/yes'), inbound(2, '/yes'));
    yield* settle(fixture.engine);
    expect(fixture.responses).toStrictEqual([{ id: 1, result: { decision: 'accept' } }]);
    expect(fixture.sent).toContain('There is no permission request awaiting a decision');
    expect(fixture.sent.filter((text) => text.startsWith('Permission requested:'))).toHaveLength(2);

    fixture.push(inbound(3, '/no'));
    yield* settle(fixture.engine);
    expect(fixture.responses).toStrictEqual([
      { id: 1, result: { decision: 'accept' } },
      { id: 2, result: { decision: 'decline' } },
    ]);
    expect(fixture.inputs).toStrictEqual([]);
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('invalid commands are consumed and upstream resolution cancels the visible prompt', () =>
  Effect.gen(function* invalidatePrompt() {
    const fixture = yield* makeEngineFixture();
    fixture.requestApproval(commandRequest(7, 'sensitive-command'));
    yield* settle(fixture.engine);
    fixture.push(inbound(1, '/yes please'));
    yield* settle(fixture.engine);
    expect(fixture.sent).toContain('Reply with exactly /yes or /no');
    expect(fixture.responses).toStrictEqual([]);
    expect(fixture.inputs).toStrictEqual([]);

    fixture.resolveServerRequest(7);
    yield* settle(fixture.engine);
    expect(stateOf(fixture.database, 7)).toBe('Cancelled');
    expect(fixture.sent).toContain('Permission request was cancelled by Codex');
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('marks live approvals orphaned when the app-server connection closes', () =>
  Effect.gen(function* orphanPrompt() {
    const fixture = yield* makeEngineFixture();
    fixture.requestApproval(commandRequest(9, 'connection-bound-command'));
    yield* settle(fixture.engine);
    fixture.closeCodexConnection();
    yield* settle(fixture.engine);
    expect(stateOf(fixture.database, 9)).toBe('Orphaned');
    expect(fixture.responses).toStrictEqual([]);
    expect(fixture.sent).toContain(
      'Permission request was cancelled because its Codex connection ended. Please retry the operation',
    );
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('expires a visible prompt and returns a fail-closed response', () =>
  Effect.gen(function* expirePrompt() {
    const fixture = yield* makeEngineFixture({ behavior: { approvalExpiryMs: 0 } });
    fixture.requestApproval(commandRequest(11, 'eventually-expired-command'));
    yield* settle(fixture.engine);
    expect(fixture.responses).toStrictEqual([{ id: 11, result: { decision: 'decline' } }]);
    expect(stateOf(fixture.database, 11)).toBe('Expired');
    expect(fixture.sent).toContain('Permission request expired');
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('reports an orphan instead of approval when the upstream response write fails', () =>
  Effect.gen(function* failResponse() {
    const fixture = yield* makeEngineFixture({ behavior: { responseFailure: 'connection lost' } });
    fixture.requestApproval(commandRequest(12, 'write-after-disconnect'));
    yield* settle(fixture.engine);
    fixture.push(inbound(1, '/yes'));
    yield* settle(fixture.engine);
    expect(stateOf(fixture.database, 12)).toBe('Orphaned');
    expect(fixture.sent).not.toContain('Approved');
    expect(fixture.sent).toContain(
      'Permission request was cancelled because its Codex connection ended. Please retry the operation',
    );
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect('fails closed when the permission prompt cannot be delivered', () =>
  Effect.gen(function* failPromptDelivery() {
    const fixture = yield* makeEngineFixture({ behavior: { deliveryFailure: 'chat unavailable' } });
    fixture.requestApproval(commandRequest(13, 'undeliverable-command'));
    yield* settle(fixture.engine);
    expect(stateOf(fixture.database, 13)).toBe('Expired');
    expect(fixture.responses).toStrictEqual([{ id: 13, result: { decision: 'decline' } }]);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toContain('Permission requested: Command');
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);

it.effect(
  'does not ingest or resolve approval replies while the conversation boundary is invalid',
  () =>
    Effect.gen(function* invalidConversationApproval() {
      let valid = true;
      const fixture = yield* makeEngineFixture({
        conversationProbe: () =>
          valid
            ? Effect.void
            : Effect.fail(
                new ConversationMismatchError({
                  chatGuid: 'any;-;+15555550199',
                  handle: '+15555550199',
                  message: 'configured conversation changed',
                }),
              ),
      });
      fixture.requestApproval(commandRequest(15, 'boundary-sensitive-command'));
      yield* settle(fixture.engine);
      expect(stateOf(fixture.database, 15)).toBe('Pending');
      const sentBeforeInvalidation = [...fixture.sent];

      valid = false;
      expect(
        yield* fixture.conversation.revalidate(
          new Date('2026-07-14T12:01:00.000Z'),
          'DatabaseChanged',
        ),
      ).toBe(false);
      fixture.push(inbound(1, '/yes'));
      yield* settle(fixture.engine);
      expect(stateOf(fixture.database, 15)).toBe('Pending');
      expect(fixture.responses).toStrictEqual([]);
      expect(fixture.sent).toStrictEqual(sentBeforeInvalidation);

      valid = true;
      expect(
        yield* fixture.conversation.revalidate(
          new Date('2026-07-14T12:02:00.000Z'),
          'DatabaseChanged',
        ),
      ).toBe(true);
      yield* settle(fixture.engine);
      expect(stateOf(fixture.database, 15)).toBe('Approved');
      expect(fixture.responses).toStrictEqual([{ id: 15, result: { decision: 'accept' } }]);
      yield* fixture.engine.shutdown;
      fixture.remove();
    }),
);

it.effect('marks a crash-window decision orphaned when no response receipt was persisted', () =>
  Effect.gen(function* recoverUncertainResponse() {
    const { params } = commandRequest(14, 'crash-window-command');
    const fixture = yield* makeEngineFixture({
      prepare: (database) =>
        Effect.sync(() => {
          database.run(
            `INSERT INTO approval_requests(
               id, connection_id, rpc_request_id_json, method, operation, params_json,
               file_paths_json, state, requested_at, expires_at, delivered_at, response_json
             ) VALUES (?, ?, ?, ?, 'Command', ?, '[]', 'Approved', ?, ?, ?, ?)`,
            [
              'approval-crash-window',
              'old-connection',
              '14',
              'item/commandExecution/requestApproval',
              JSON.stringify(params),
              '2026-07-14T12:00:00.000Z',
              '2026-07-14T12:10:00.000Z',
              '2026-07-14T12:00:01.000Z',
              JSON.stringify({ decision: 'accept' }),
            ],
          );
        }),
    });
    expect(stateOf(fixture.database, 14)).toBe('Orphaned');
    expect(fixture.sent).toContain(
      'Permission request was cancelled because its Codex connection ended. Please retry the operation',
    );
    yield* fixture.engine.shutdown;
    fixture.remove();
  }),
);
