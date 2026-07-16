import type { ObservedMessage } from '../domain/inbound';

const newestMessage = (messages: readonly ObservedMessage[]): ObservedMessage | null => {
  let newest: ObservedMessage | null = null;
  for (const message of messages) {
    if (newest === null || message.rowId > newest.rowId) {
      newest = message;
    }
  }
  return newest;
};

export { newestMessage };
