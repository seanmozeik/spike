import { isObject } from '../object-guard';

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
  readonly final: ClassifiedFinal;
}

type ClassifiedFinal =
  | { readonly kind: 'Pending' }
  | { readonly itemId: string; readonly kind: 'Ready'; readonly text: string }
  | { readonly candidateItemIds: readonly string[]; readonly kind: 'Ambiguous' }
  | { readonly kind: 'Missing' };

interface OutputAccumulator {
  acknowledgement: string | null;
  fallback: AgentMessageItem | null;
  readonly explicitFinals: Map<string, AgentMessageItem>;
}

const ACKNOWLEDGEMENT_LIMIT = 240;

const agentMessage = (item: unknown): AgentMessageItem | null => {
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

const completedAgentMessage = (notification: CodexNotification): AgentMessageItem | null => {
  if (notification.method !== 'item/completed' || !isObject(notification.params)) {
    return null;
  }
  return agentMessage(notification.params['item']);
};

const compactAcknowledgement = (text: string): string => {
  const compact = text.replaceAll(/\s+/gu, ' ').trim();
  if (compact.length <= ACKNOWLEDGEMENT_LIMIT) {
    return compact;
  }
  return `${compact.slice(0, ACKNOWLEDGEMENT_LIMIT - 1).trimEnd()}…`;
};

const classifyFinal = (
  output: OutputAccumulator,
  turnCompletedSuccessfully: boolean,
): ClassifiedFinal => {
  if (!turnCompletedSuccessfully) {
    return { kind: 'Pending' };
  }
  if (output.explicitFinals.size > 1) {
    return { candidateItemIds: [...output.explicitFinals.keys()], kind: 'Ambiguous' };
  }
  const candidate = output.explicitFinals.values().next().value ?? output.fallback;
  return candidate === null
    ? { kind: 'Missing' }
    : { itemId: candidate.id, kind: 'Ready', text: candidate.text };
};

const classifyAgentMessages = (
  items: readonly unknown[],
  turnCompletedSuccessfully: boolean,
): ClassifiedOutput => {
  const output: OutputAccumulator = {
    acknowledgement: null,
    explicitFinals: new Map<string, AgentMessageItem>(),
    fallback: null,
  };
  for (const item of items) {
    const message = agentMessage(item);
    if (message !== null) {
      if (message.phase === 'commentary' && output.acknowledgement === null) {
        output.acknowledgement = compactAcknowledgement(message.text);
      } else if (message.phase === 'final_answer') {
        output.explicitFinals.set(message.id, message);
      } else if (message.phase === null) {
        output.fallback = message;
      }
    }
  }
  return {
    acknowledgement: output.acknowledgement,
    final: classifyFinal(output, turnCompletedSuccessfully),
  };
};

const collectOutput = (
  notifications: readonly CodexNotification[],
  turnCompletedSuccessfully: boolean,
): ClassifiedOutput =>
  classifyAgentMessages(
    notifications
      .map((notification) => completedAgentMessage(notification))
      .filter((message): message is AgentMessageItem => message !== null),
    turnCompletedSuccessfully,
  );

export { classifyAgentMessages, collectOutput, completedAgentMessage };
export type { AgentMessageItem, ClassifiedFinal, ClassifiedOutput, CodexNotification };
