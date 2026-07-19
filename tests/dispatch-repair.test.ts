import { expect, test } from 'vitest';

import { CodexTurnId, GenerationId, LogicalTurnId } from '../src/domain/ids';
import type { SchedulerState } from '../src/scheduler/model';
import { dispatchFailureIdentity } from '../src/service/dispatch-repair';

test('a stale pool timer failure cannot target an unrelated successor turn', () => {
  const state: SchedulerState = {
    active: {
      acknowledged: false,
      codexTurnId: CodexTurnId.make('successor-codex-turn'),
      logicalTurnId: LogicalTurnId.make('successor-logical-turn'),
    },
    codexThreadId: null,
    configurationCurrent: true,
    generationBroken: false,
    generationId: GenerationId.make('successor-generation'),
    pool: [],
  };

  const identity = dispatchFailureIdentity(state, LogicalTurnId.make('stale-pool-timer-start'), {
    generationId: GenerationId.make('prior-generation'),
    logicalTurnId: LogicalTurnId.make('prior-logical-turn'),
  });

  expect(identity).toBeNull();
  expect(state.active?.logicalTurnId).toBe('successor-logical-turn');
});
