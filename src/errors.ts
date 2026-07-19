import { Schema } from 'effect';

export class SpikeRuntimeError extends Schema.TaggedErrorClass<SpikeRuntimeError>()(
  'SpikeRuntimeError',
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

export class MessagesPermissionError extends Schema.TaggedErrorClass<MessagesPermissionError>()(
  'MessagesPermissionError',
  { cause: Schema.Defect(), databasePath: Schema.String, message: Schema.String },
) {}

export class MessagesQueryError extends Schema.TaggedErrorClass<MessagesQueryError>()(
  'MessagesQueryError',
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

export class ConversationMismatchError extends Schema.TaggedErrorClass<ConversationMismatchError>()(
  'ConversationMismatchError',
  { chatGuid: Schema.String, handle: Schema.String, message: Schema.String },
) {}

export class JournalTransactionError extends Schema.TaggedErrorClass<JournalTransactionError>()(
  'JournalTransactionError',
  { cause: Schema.Defect(), message: Schema.String, transaction: Schema.String },
) {}

export const journalTransactionError = (
  transaction: string,
  message: string,
  cause: unknown,
): JournalTransactionError => new JournalTransactionError({ cause, message, transaction });

export class CodexRuntimeError extends Schema.TaggedErrorClass<CodexRuntimeError>()(
  'CodexRuntimeError',
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

export class AccountStoreError extends Schema.TaggedErrorClass<AccountStoreError>()(
  'AccountStoreError',
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

export class WaitingForCapacity extends Schema.TaggedErrorClass<WaitingForCapacity>()(
  'WaitingForCapacity',
  { resetAt: Schema.NullOr(Schema.DateFromString) },
) {}

export class WaitingForAuthentication extends Schema.TaggedErrorClass<WaitingForAuthentication>()(
  'WaitingForAuthentication',
  { message: Schema.String },
) {}

export class GenerationBroken extends Schema.TaggedErrorClass<GenerationBroken>()(
  'GenerationBroken',
  { message: Schema.String },
) {}

export const isGenerationBroken = (value: unknown): value is GenerationBroken =>
  typeof value === 'object' &&
  value !== null &&
  '_tag' in value &&
  value['_tag'] === 'GenerationBroken';
