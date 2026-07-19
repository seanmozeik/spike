import type { CodexTurnId } from '../domain/ids';
import { classifyAgentMessages, type ClassifiedOutput } from './output-classifier';
import type { ThreadSnapshot } from './reconcile';

type RecoveredTurn =
  | { readonly kind: 'Completed'; readonly output: ClassifiedOutput }
  | { readonly kind: 'Failed'; readonly message: string }
  | { readonly kind: 'Missing' }
  | { readonly kind: 'Running' };

const recoverTurn = (snapshot: ThreadSnapshot, turnId: CodexTurnId): RecoveredTurn => {
  const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
  if (turn === undefined) {
    return { kind: 'Missing' };
  }
  if (turn.status === 'failed' || turn.status === 'interrupted') {
    return { kind: 'Failed', message: JSON.stringify(turn.error ?? turn.status) };
  }
  if (turn.status !== 'completed') {
    return { kind: 'Running' };
  }
  return { kind: 'Completed', output: classifyAgentMessages(turn.items, true) };
};

export { recoverTurn };
export type { RecoveredTurn };
