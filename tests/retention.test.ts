import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { GenerationId } from '../src/domain/ids';
import {
  approvalRequest,
  CUTOFF,
  ingest,
  makeRetentionFixture,
  NOW,
  OLD,
  startCodexTurn,
} from './retention-fixture';

interface PayloadRow {
  readonly id: string;
  readonly payload_redacted_at: null | string;
  readonly state: string;
  readonly text: null | string;
}

it.effect('redacts completed turn payloads while preserving a live turn', () =>
  Effect.gen(function* terminalActiveMatrix() {
    const fixture = yield* makeRetentionFixture();
    const terminalMessage = yield* ingest(fixture, 1, 'terminal private input', [
      {
        attachmentGuid: 'terminal-attachment',
        filename: 'private.jpg',
        mimeType: 'image/jpeg',
        totalBytes: 42,
        transferName: 'private.jpg',
        uti: 'public.jpeg',
      },
    ]);
    const terminal = yield* startCodexTurn(fixture, 'terminal', terminalMessage);
    const delivered = yield* fixture.delivery.prepareAssistantMessage(
      terminal.logicalTurnId,
      'item-terminal',
      'Final',
      'terminal private output',
      OLD,
    );
    const [deliveredChunk] = delivered.chunks;
    if (deliveredChunk === undefined) {
      throw new Error('terminal delivery did not create a chunk');
    }
    const deliveryAttempt = yield* fixture.delivery.claimAttempt(deliveredChunk.id, 0, OLD);
    if (deliveryAttempt === null) {
      throw new Error('terminal delivery attempt was not claimed');
    }
    yield* fixture.delivery.markSent(deliveryAttempt, deliveredChunk.id, OLD);
    yield* fixture.codex.finishLogicalTurn(terminal.logicalTurnId, 'Completed', OLD);
    yield* fixture.scheduler.commitTransition(
      {
        actions: [{ kind: 'CompleteTurn', logicalTurnId: terminal.logicalTurnId }],
        state: { ...fixture.state, active: null },
      },
      OLD,
    );

    const activeMessage = yield* ingest(fixture, 2, 'active private input');
    const active = yield* startCodexTurn(fixture, 'active', activeMessage);
    yield* fixture.delivery.prepareAssistantMessage(
      active.logicalTurnId,
      'item-active',
      'Final',
      'active private output',
      OLD,
    );

    expect(yield* fixture.journal.redactTerminalPayloads(CUTOFF, NOW)).toBe(1);
    expect(yield* fixture.journal.listInbound).toMatchObject([
      { rowId: 1, text: null },
      { rowId: 2, text: 'active private input' },
    ]);
    expect(
      fixture.database
        .query<{ filename: null | string; state: string }, []>(
          'SELECT filename, state FROM attachments',
        )
        .get(),
    ).toStrictEqual({ filename: null, state: 'Redacted' });
    expect(
      fixture.database
        .query<PayloadRow, []>(
          `SELECT source_id AS id, text, state, payload_redacted_at
           FROM outbound_messages ORDER BY source_id`,
        )
        .all(),
    ).toStrictEqual([
      {
        id: 'item-active',
        payload_redacted_at: null,
        state: 'Prepared',
        text: 'active private output',
      },
      {
        id: 'item-terminal',
        payload_redacted_at: NOW.toISOString(),
        state: 'Delivered',
        text: null,
      },
    ]);
    expect(
      fixture.database
        .query<PayloadRow, []>(
          `SELECT om.source_id AS id, oc.text, oc.state, oc.payload_redacted_at
           FROM outbound_chunks oc JOIN outbound_messages om ON om.id = oc.outbound_message_id
           ORDER BY om.source_id`,
        )
        .all(),
    ).toStrictEqual([
      {
        id: 'item-active',
        payload_redacted_at: null,
        state: 'Prepared',
        text: 'active private output',
      },
      { id: 'item-terminal', payload_redacted_at: NOW.toISOString(), state: 'Sent', text: null },
    ]);
    expect(
      fixture.database
        .query<{ id: string; payload_json: null | string; payload_redacted_at: null | string }, []>(
          `SELECT codex_item_id AS id, payload_json, payload_redacted_at
           FROM codex_agent_items ORDER BY codex_item_id`,
        )
        .all(),
    ).toStrictEqual([
      {
        id: 'item-active',
        payload_json: '{"text":"active agent payload"}',
        payload_redacted_at: null,
      },
      { id: 'item-terminal', payload_json: null, payload_redacted_at: NOW.toISOString() },
    ]);
    fixture.close();
  }),
);

it.effect('redacts Failed and Prepared sibling chunks after their parent fails', () =>
  Effect.gen(function* parentTerminalChunks() {
    const fixture = yield* makeRetentionFixture();
    const message = yield* ingest(fixture, 1, 'delivery failure input');
    const turn = yield* startCodexTurn(fixture, 'failed', message);
    const prepared = yield* fixture.delivery.prepareAssistantMessage(
      turn.logicalTurnId,
      'item-failed',
      'Final',
      'private failed output '.repeat(600),
      OLD,
    );
    expect(prepared.chunks.length).toBeGreaterThan(1);
    const [first] = prepared.chunks;
    if (first === undefined) {
      throw new Error('failed delivery did not create a chunk');
    }
    yield* fixture.delivery.claimAttempt(first.id, 0, OLD);
    yield* fixture.delivery.markFailed(first.id, 'delivery failed', OLD);
    yield* fixture.scheduler.commitTransition(
      {
        actions: [{ kind: 'FailTurn', logicalTurnId: turn.logicalTurnId }],
        state: { ...fixture.state, active: null },
      },
      OLD,
    );
    const states = fixture.database
      .query<{ state: string }, []>('SELECT state FROM outbound_chunks ORDER BY ordinal')
      .all()
      .map(({ state }) => state);
    expect(states).toContain('Failed');
    expect(states).toContain('Prepared');

    yield* fixture.journal.redactTerminalPayloads(CUTOFF, NOW);
    expect(
      fixture.database
        .query<{ payload_redacted_at: null | string; text: null | string }, []>(
          'SELECT text, payload_redacted_at FROM outbound_chunks ORDER BY ordinal',
        )
        .all(),
    ).toStrictEqual(
      prepared.chunks.map(() => ({ payload_redacted_at: NOW.toISOString(), text: null })),
    );
    fixture.close();
  }),
);

it.effect('terminalizes reset attempts and redacts legacy superseded-turn items', () =>
  Effect.gen(function* supersededAttempt() {
    const fixture = yield* makeRetentionFixture();
    const message = yield* ingest(fixture, 1, 'superseded input');
    const turn = yield* startCodexTurn(fixture, 'superseded', message);
    const command = yield* ingest(fixture, 2, '/new');
    const replacement = {
      active: null,
      codexThreadId: null,
      generationBroken: false,
      generationId: GenerationId.make('replacement-generation'),
      pool: [],
    } as const;
    yield* fixture.scheduler.commitTransition(
      {
        actions: [
          {
            commandMessageId: command.id,
            kind: 'ResetGeneration',
            newGenerationId: replacement.generationId,
            oldGenerationId: fixture.state.generationId,
          },
        ],
        state: replacement,
      },
      OLD,
    );
    expect(
      fixture.database
        .query<{ finished_at: null | string; state: string }, [string]>(
          'SELECT state, finished_at FROM codex_attempts WHERE id = ?',
        )
        .get(turn.attemptId),
    ).toStrictEqual({ finished_at: OLD.toISOString(), state: 'Failed' });

    fixture.database.run(
      "UPDATE codex_attempts SET state = 'Accepted', finished_at = NULL WHERE id = ?",
      [turn.attemptId],
    );
    yield* fixture.journal.redactTerminalPayloads(CUTOFF, NOW);
    expect(
      fixture.database
        .query<{ payload_json: null | string }, []>(
          "SELECT payload_json FROM codex_agent_items WHERE codex_item_id = 'item-superseded'",
        )
        .get(),
    ).toStrictEqual({ payload_json: null });
    fixture.close();
  }),
);

it.effect('redacts handled control and approval commands but keeps ordinary input', () =>
  Effect.gen(function* handledCommands() {
    const fixture = yield* makeRetentionFixture();
    const control = yield* ingest(fixture, 1, '/status');
    const approvalCommand = yield* ingest(fixture, 2, '/yes');
    yield* ingest(fixture, 3, 'ordinary unassigned input');
    yield* fixture.scheduler.commitTransition(
      { actions: [{ commandMessageId: control.id, kind: 'ReplyStatus' }], state: fixture.state },
      OLD,
    );
    const approval = yield* fixture.approvals.enqueue(
      approvalRequest(4, 'private command'),
      'four',
    );
    yield* fixture.approvals.markDelivered(approval.id, OLD);
    expect(yield* fixture.approvals.resolveCommand(approvalCommand, OLD)).toMatchObject({
      kind: 'Resolved',
    });

    yield* fixture.journal.redactTerminalPayloads(CUTOFF, NOW);
    expect(yield* fixture.journal.listInbound).toMatchObject([
      { rowId: 1, text: null },
      { rowId: 2, text: null },
      { rowId: 3, text: 'ordinary unassigned input' },
    ]);
    fixture.close();
  }),
);

it.effect('prunes old failure and account observations without deleting recent rows', () =>
  Effect.gen(function* leafRetention() {
    const fixture = yield* makeRetentionFixture();
    fixture.database.run(
      `INSERT INTO failures(correlation_id, operation, error_tag, message, created_at)
       VALUES ('old', 'test', 'OldFailure', 'old failure', ?),
              ('recent', 'test', 'RecentFailure', 'recent failure', ?)`,
      [OLD.toISOString(), NOW.toISOString()],
    );
    fixture.database.run(
      `INSERT INTO account_observations(account_id, observed_at, usable, mode, usage_json)
       VALUES ('old-account', ?, 1, 'Available', '{"private":"old"}'),
              ('recent-account', ?, 1, 'Available', '{"private":"recent"}')`,
      [OLD.toISOString(), NOW.toISOString()],
    );

    yield* fixture.journal.redactTerminalPayloads(CUTOFF, NOW);
    expect(
      fixture.database.query<{ message: string }, []>('SELECT message FROM failures').all(),
    ).toStrictEqual([{ message: 'recent failure' }]);
    expect(
      fixture.database
        .query<{ account_id: string }, []>('SELECT account_id FROM account_observations')
        .all(),
    ).toStrictEqual([{ account_id: 'recent-account' }]);
    fixture.close();
  }),
);
