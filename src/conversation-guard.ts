import type { ChatGuid } from './domain/ids';
import type { ObservedMessage } from './domain/inbound';

interface ConfiguredConversation {
  readonly chatGuid: ChatGuid;
  readonly handle: string;
}

const belongsToConversation = (
  conversation: ConfiguredConversation,
  message: ObservedMessage,
): boolean => {
  const untrusted: Record<string, unknown> = { ...message };
  return (
    message.chatGuid === conversation.chatGuid &&
    message.handle.toLocaleLowerCase() === conversation.handle.toLocaleLowerCase() &&
    untrusted['isFromMe'] === false &&
    untrusted['service'] === 'iMessage'
  );
};

export { belongsToConversation };
export type { ConfiguredConversation };
