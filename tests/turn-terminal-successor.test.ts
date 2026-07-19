import { describe, expect, it } from 'vitest';

import { GenerationId, LogicalTurnId } from '../src/domain/ids';
import type { SchedulerState } from '../src/scheduler/model';
import type { TurnTerminalObligation } from '../src/service/turn-terminal-model';
import { terminalSuccessorIdentity } from '../src/service/turn-terminal-successor';

const originalGeneration = GenerationId.make('generation-original');
const terminalGeneration = GenerationId.make('generation-terminal');
const resetGeneration = GenerationId.make('generation-reset');
const originalTurn = LogicalTurnId.make('turn-original');
const intendedSuccessor = LogicalTurnId.make('turn-intended-successor');
const postResetTurn = LogicalTurnId.make('turn-after-reset');

const obligation: TurnTerminalObligation = {
  error: new Error('successor start failed'),
  event: {
    at: new Date('2026-07-19T12:00:00.000Z'),
    kind: 'TurnFailed',
    logicalTurnId: originalTurn,
    newGenerationId: terminalGeneration,
    nextLogicalTurnId: intendedSuccessor,
  },
  identity: { generationId: originalGeneration, logicalTurnId: originalTurn },
  kind: 'Failure',
  sourceId: originalTurn,
};

const state = (
  generationId: SchedulerState['generationId'],
  logicalTurnId: LogicalTurnId,
): SchedulerState =>
  ({
    active: { acknowledged: false, codexTurnId: null, logicalTurnId },
    codexThreadId: null,
    configurationCurrent: true,
    generationBroken: false,
    generationId,
    pool: [],
  }) satisfies SchedulerState;

describe('terminal successor identity', () => {
  it('rejects unrelated work committed by /new after a failed terminal dispatch', () => {
    expect(terminalSuccessorIdentity(obligation, state(resetGeneration, postResetTurn))).toBeNull();
  });

  it('recognizes the intended successor in the predecessor generation', () => {
    expect(
      terminalSuccessorIdentity(obligation, state(originalGeneration, intendedSuccessor)),
    ).toEqual({ generationId: originalGeneration, logicalTurnId: intendedSuccessor });
  });

  it('recognizes the intended successor created by terminal configuration rotation', () => {
    expect(
      terminalSuccessorIdentity(obligation, state(terminalGeneration, intendedSuccessor)),
    ).toEqual({ generationId: terminalGeneration, logicalTurnId: intendedSuccessor });
  });
});
