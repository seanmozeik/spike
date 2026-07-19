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
  expect(output.final).toEqual({ itemId: 'final', kind: 'Ready', text: 'Done.' });
});

it('uses only the last phase-less completed message as a successful compatibility fallback', () => {
  expect(
    collectOutput([message('one', 'first', null), message('two', 'last', null)], true),
  ).toEqual({ acknowledgement: null, final: { itemId: 'two', kind: 'Ready', text: 'last' } });
  expect(collectOutput([message('one', 'must not leak', null)], false).final).toEqual({
    kind: 'Pending',
  });
});

it('keeps the final answer when commentary is the last completed item', () => {
  expect(
    collectOutput(
      [
        message('final', 'The completed answer.', 'final_answer'),
        message('trailing', 'A trailing progress note.', 'commentary'),
      ],
      true,
    ),
  ).toEqual({
    acknowledgement: 'A trailing progress note.',
    final: { itemId: 'final', kind: 'Ready', text: 'The completed answer.' },
  });
});

it('never promotes commentary-only output to a final answer', () => {
  expect(collectOutput([message('commentary', 'Still working.', 'commentary')], true)).toEqual({
    acknowledgement: 'Still working.',
    final: { kind: 'Missing' },
  });
});

it('preserves every explicit candidate instead of choosing one ambiguous final answer', () => {
  expect(
    collectOutput(
      [
        message('final-one', 'First candidate.', 'final_answer'),
        message('fallback', 'Compatibility fallback.', null),
        message('final-two', 'Second candidate.', 'final_answer'),
      ],
      true,
    ),
  ).toEqual({
    acknowledgement: null,
    final: { candidateItemIds: ['final-one', 'final-two'], kind: 'Ambiguous' },
  });
});

it('treats repeated completion notifications for one final item as one candidate', () => {
  expect(
    collectOutput(
      [
        message('final', 'One answer.', 'final_answer'),
        message('final', 'One answer.', 'final_answer'),
      ],
      true,
    ).final,
  ).toEqual({ itemId: 'final', kind: 'Ready', text: 'One answer.' });
});
