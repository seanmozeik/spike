import { expect, it } from 'vitest';

import {
  canonicalInputFingerprint,
  captureFrontier,
  reconcileSubmission,
  type ThreadSnapshot,
} from '../src/codex/reconcile';

const before: ThreadSnapshot = {
  id: 'thread',
  turns: [{ id: 'old-turn', items: [{ clientId: 'old', id: 'old-user', type: 'userMessage' }] }],
};

it('reconciles zero, one, or conflicting post-frontier submission matches', () => {
  const frontier = captureFrontier(before);
  expect(reconcileSubmission(frontier, before, 'attempt').kind).toBe('Retry');
  const one: ThreadSnapshot = {
    id: 'thread',
    turns: [
      ...before.turns,
      { id: 'new-turn', items: [{ clientId: 'attempt', id: 'new-user', type: 'userMessage' }] },
    ],
  };
  expect(reconcileSubmission(frontier, one, 'attempt')).toEqual({
    kind: 'Resume',
    turnId: 'new-turn',
  });
  const conflict: ThreadSnapshot = {
    id: 'thread',
    turns: [
      ...one.turns,
      { id: 'other-turn', items: [{ clientId: 'attempt', id: 'other-user', type: 'userMessage' }] },
    ],
  };
  expect(reconcileSubmission(frontier, conflict, 'attempt').kind).toBe('BreakGeneration');
});

it('fingerprints canonically equivalent Unicode input identically', () => {
  expect(canonicalInputFingerprint('café')).toBe(canonicalInputFingerprint('cafe\u0301'));
});

it('preserves legacy text-only fingerprints while binding image content hashes', () => {
  expect(canonicalInputFingerprint('hello')).toBe(
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
  expect(canonicalInputFingerprint('hello', ['image-hash'])).not.toBe(
    canonicalInputFingerprint('hello'),
  );
});
