import { createHash } from 'node:crypto';

import { GenerationBroken } from '../errors';

interface Frontier {
  readonly itemIds: readonly string[];
  readonly turnIds: readonly string[];
}

interface ThreadItem {
  readonly clientId?: null | string;
  readonly id: string;
  readonly phase?: null | string;
  readonly text?: string;
  readonly type: string;
}

interface ThreadTurn {
  readonly error?: unknown;
  readonly id: string;
  readonly items: readonly ThreadItem[];
  readonly status?: string;
}

interface ThreadSnapshot {
  readonly id: string;
  readonly turns: readonly ThreadTurn[];
}

type Reconciliation =
  | { readonly kind: 'Resume'; readonly turnId: string }
  | { readonly kind: 'Retry' }
  | { readonly error: GenerationBroken; readonly kind: 'BreakGeneration' };

const canonicalInputFingerprint = (input: string): string =>
  createHash('sha256').update(input.normalize('NFC')).digest('hex');

const captureFrontier = (thread: ThreadSnapshot): Frontier => ({
  itemIds: thread.turns.flatMap((turn) => turn.items.map((item) => item.id)),
  turnIds: thread.turns.map((turn) => turn.id),
});

const reconcileSubmission = (
  frontier: Frontier,
  current: ThreadSnapshot,
  clientUserMessageId: string,
): Reconciliation => {
  const knownItems = new Set(frontier.itemIds);
  const matches: string[] = [];
  for (const turn of current.turns) {
    const matched = turn.items.some(
      (item) =>
        !knownItems.has(item.id) &&
        item.type === 'userMessage' &&
        item.clientId === clientUserMessageId,
    );
    if (matched) {
      matches.push(turn.id);
    }
  }
  if (matches.length === 0) {
    return { kind: 'Retry' };
  }
  if (matches.length === 1) {
    return { kind: 'Resume', turnId: matches[0] ?? '' };
  }
  return {
    error: new GenerationBroken({
      message: `submission ${clientUserMessageId} matched ${String(matches.length)} turns`,
    }),
    kind: 'BreakGeneration',
  };
};

export { canonicalInputFingerprint, captureFrontier, reconcileSubmission };
export type { Frontier, Reconciliation, ThreadItem, ThreadSnapshot, ThreadTurn };
