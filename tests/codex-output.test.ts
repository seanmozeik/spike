import { expect, it } from 'vitest';

import { collectOutput, type CodexNotification } from '../src/codex/output-classifier';

const message = (
  id: string,
  text: string,
  phase: 'commentary' | 'final_answer' | null,
): CodexNotification => ({
  method: 'item/completed',
  params: { item: { id, phase, text, type: 'agentMessage' } },
});

it('exposes only the first compact acknowledgement and successful final answer', () => {
  const output = collectOutput(
    [
      { method: 'item/reasoning/textDelta', params: { delta: 'secret' } },
      message('ack-1', `  Looking   into ${'x'.repeat(300)}  `, 'commentary'),
      message('ack-2', 'later narration', 'commentary'),
      { method: 'item/mcpToolCall/progress', params: { message: 'tool' } },
      message('final', 'Done.', 'final_answer'),
    ],
    true,
  );
  expect(output.acknowledgement?.length).toBe(240);
  expect(output.acknowledgement?.endsWith('…')).toBe(true);
  expect(output.finalAnswer).toBe('Done.');
});

it('uses only the last phase-less completed message as a successful compatibility fallback', () => {
  expect(
    collectOutput([message('one', 'first', null), message('two', 'last', null)], true),
  ).toEqual({ acknowledgement: null, finalAnswer: 'last' });
  expect(collectOutput([message('one', 'must not leak', null)], false).finalAnswer).toBeNull();
});
