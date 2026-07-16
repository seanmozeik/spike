import type { CodexTurnId } from '../domain/ids';
import type { ClassifiedOutput } from './output-classifier';
import type { ThreadItem, ThreadSnapshot } from './reconcile';

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
  const messages = turn.items.filter(
    (item): item is ThreadItem & { readonly text: string } =>
      item.type === 'agentMessage' && typeof item.text === 'string',
  );
  const acknowledgement = messages.find((item) => item.phase === 'commentary')?.text ?? null;
  const finalAnswer =
    messages.findLast((item) => item.phase === 'final_answer')?.text ??
    messages.at(-1)?.text ??
    null;
  return { kind: 'Completed', output: { acknowledgement, finalAnswer } };
};

export { recoverTurn };
export type { RecoveredTurn };
