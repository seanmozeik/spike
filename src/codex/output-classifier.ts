interface AgentMessageItem {
  readonly id: string;
  readonly phase: 'commentary' | 'final_answer' | null;
  readonly text: string;
  readonly type: 'agentMessage';
}

interface CodexNotification {
  readonly method: string;
  readonly params: unknown;
}

interface ClassifiedOutput {
  readonly acknowledgement: string | null;
  readonly finalAnswer: string | null;
}

interface OutputAccumulator {
  acknowledgement: string | null;
  fallback: string | null;
  finalAnswer: string | null;
}

const ACKNOWLEDGEMENT_LIMIT = 240;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const completedAgentMessage = (notification: CodexNotification): AgentMessageItem | null => {
  if (notification.method !== 'item/completed' || !isObject(notification.params)) {
    return null;
  }
  const { item } = notification.params;
  if (!isObject(item) || item['type'] !== 'agentMessage') {
    return null;
  }
  if (typeof item['id'] !== 'string' || typeof item['text'] !== 'string') {
    return null;
  }
  const { phase } = item;
  if (phase !== null && phase !== 'commentary' && phase !== 'final_answer') {
    return null;
  }
  return { id: item['id'], phase, text: item['text'], type: 'agentMessage' };
};

const compactAcknowledgement = (text: string): string => {
  const compact = text.replaceAll(/\s+/gu, ' ').trim();
  if (compact.length <= ACKNOWLEDGEMENT_LIMIT) {
    return compact;
  }
  return `${compact.slice(0, ACKNOWLEDGEMENT_LIMIT - 1).trimEnd()}…`;
};

const collectOutput = (
  notifications: readonly CodexNotification[],
  turnCompletedSuccessfully: boolean,
): ClassifiedOutput => {
  const output: OutputAccumulator = { acknowledgement: null, fallback: null, finalAnswer: null };
  for (const notification of notifications) {
    const message = completedAgentMessage(notification);
    if (message !== null) {
      if (message.phase === 'commentary' && output.acknowledgement === null) {
        output.acknowledgement = compactAcknowledgement(message.text);
      } else if (message.phase === 'final_answer') {
        output.finalAnswer = message.text;
      } else if (message.phase === null) {
        output.fallback = message.text;
      }
    }
  }
  return {
    acknowledgement: output.acknowledgement,
    finalAnswer: turnCompletedSuccessfully ? (output.finalAnswer ?? output.fallback) : null,
  };
};

export { collectOutput, completedAgentMessage };
export type { AgentMessageItem, ClassifiedOutput, CodexNotification };
