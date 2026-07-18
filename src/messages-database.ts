import { Database } from 'bun:sqlite';

import {
  type ConfiguredMessagesConversation,
  validateConfiguredConversation,
} from './messages-conversation';

interface MessagesDatabaseOptions extends ConfiguredMessagesConversation {
  readonly databasePath: string;
}

const openValidatedMessagesDatabase = (options: MessagesDatabaseOptions): Database => {
  const database = new Database(options.databasePath, { readonly: true, strict: true });
  try {
    validateConfiguredConversation(database, options);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

export { openValidatedMessagesDatabase };
export type { MessagesDatabaseOptions };
