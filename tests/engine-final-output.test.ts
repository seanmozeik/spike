import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { inbound, makeEngineFixture, settle } from './engine-fixture';
import { seedActiveTurn } from './engine-seeds';

const ambiguousMessage = (first: string, second: string): string =>
  `Codex completed with multiple final answers: ${first}, ${second}`;

it.effect('rejects multiple explicit final answers from a live turn', () =>
  Effect.gen(function* ambiguousLiveFinals() {
    const fixture = yield* makeEngineFixture({
      behavior: {
        classifiedOutput: {
          acknowledgement: null,
          final: { candidateItemIds: ['live-final-one', 'live-final-two'], kind: 'Ambiguous' },
        },
      },
    });
    fixture.push(inbound(1, 'produce one answer'));

    yield* settle(fixture.engine);

    const message = ambiguousMessage('live-final-one', 'live-final-two');
    expect(fixture.sent).toStrictEqual([`Spike hit an error: ${message}`]);
    expect(
      fixture.database
        .query<{ message: string }, []>('SELECT message FROM failures ORDER BY id DESC LIMIT 1')
        .get()?.message,
    ).toBe(message);
    expect(
      fixture.database.query<{ state: string }, []>('SELECT state FROM logical_turns').get()?.state,
    ).toBe('Failed');
    fixture.remove();
  }),
);

it.effect('rejects multiple explicit final answers recovered after restart', () =>
  Effect.gen(function* ambiguousRecoveredFinals() {
    const fixture = yield* makeEngineFixture({
      prepare: (database) =>
        Effect.sync(() => {
          seedActiveTurn(database);
        }),
      snapshot: {
        id: 'thread-1',
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'recovered-final-one',
                phase: 'final_answer',
                text: 'First recovered answer.',
                type: 'agentMessage',
              },
              {
                id: 'recovered-final-two',
                phase: 'final_answer',
                text: 'Second recovered answer.',
                type: 'agentMessage',
              },
            ],
            status: 'completed',
          },
        ],
      },
    });

    yield* settle(fixture.engine);

    const message = ambiguousMessage('recovered-final-one', 'recovered-final-two');
    expect(fixture.resumed).toStrictEqual(['thread-1']);
    expect(fixture.sent).toStrictEqual([`Spike hit an error: ${message}`]);
    expect(
      fixture.database
        .query<{ message: string }, []>('SELECT message FROM failures ORDER BY id DESC LIMIT 1')
        .get()?.message,
    ).toBe(message);
    expect(
      fixture.database
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM outbound_messages
           WHERE source_kind = 'CodexAgentItem' AND message_kind = 'Final'`,
        )
        .get()?.count,
    ).toBe(0);
    fixture.remove();
  }),
);
