import { expect, it } from 'vitest';

import { recoverTurn } from '../src/codex/turn-recovery';
import { CodexTurnId } from '../src/domain/ids';

const turnId = CodexTurnId.make('turn');

it('classifies recovered completed items with the live output rules', () => {
  expect(
    recoverTurn(
      {
        id: 'thread',
        turns: [
          {
            id: turnId,
            items: [
              {
                id: 'final',
                phase: 'final_answer',
                text: 'Recovered answer.',
                type: 'agentMessage',
              },
              {
                id: 'trailing-commentary',
                phase: 'commentary',
                text: 'Trailing progress.',
                type: 'agentMessage',
              },
            ],
            status: 'completed',
          },
        ],
      },
      turnId,
    ),
  ).toEqual({
    kind: 'Completed',
    output: {
      acknowledgement: 'Trailing progress.',
      final: { itemId: 'final', kind: 'Ready', text: 'Recovered answer.' },
    },
  });
});

it('preserves commentary diagnostics without inventing a recovered final answer', () => {
  expect(
    recoverTurn(
      {
        id: 'thread',
        turns: [
          {
            id: turnId,
            items: [
              {
                id: 'commentary',
                phase: 'commentary',
                text: 'Investigating.',
                type: 'agentMessage',
              },
              { id: 'missing-phase', text: 'Must not become final.', type: 'agentMessage' },
            ],
            status: 'completed',
          },
        ],
      },
      turnId,
    ),
  ).toEqual({
    kind: 'Completed',
    output: { acknowledgement: 'Investigating.', final: { kind: 'Missing' } },
  });
});

it('preserves ambiguous recovered final item identities', () => {
  expect(
    recoverTurn(
      {
        id: 'thread',
        turns: [
          {
            id: turnId,
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
      turnId,
    ),
  ).toEqual({
    kind: 'Completed',
    output: {
      acknowledgement: null,
      final: {
        candidateItemIds: ['recovered-final-one', 'recovered-final-two'],
        kind: 'Ambiguous',
      },
    },
  });
});
