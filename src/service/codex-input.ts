import type { StagedImageAttachment } from '../attachments/model';
import { inputBatchText } from '../scheduler/input-batch';
import type { PooledMessage } from '../scheduler/model';

interface RenderedCodexInput {
  readonly attachments: readonly StagedImageAttachment[];
  readonly input: string;
}

const renderCodexInput = (messages: readonly PooledMessage[]): RenderedCodexInput => {
  const seen = new Set<string>();
  const attachments: StagedImageAttachment[] = [];
  for (const message of messages) {
    for (const attachment of message.attachments) {
      if (!seen.has(attachment.contentHash)) {
        seen.add(attachment.contentHash);
        attachments.push(attachment);
      }
    }
  }
  return { attachments, input: inputBatchText(messages) };
};

export { renderCodexInput };
