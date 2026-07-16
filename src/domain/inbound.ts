import { Schema } from 'effect';

import { ChatGuid, MessageGuid, MessagesRowId } from './ids';

export const ObservedAttachment = Schema.Struct({
  attachmentGuid: Schema.String,
  filename: Schema.NullOr(Schema.String),
  mimeType: Schema.NullOr(Schema.String),
  totalBytes: Schema.NullOr(Schema.Int),
  transferName: Schema.NullOr(Schema.String),
  uti: Schema.NullOr(Schema.String),
});
export type ObservedAttachment = typeof ObservedAttachment.Type;

export const ObservedMessage = Schema.Struct({
  attachments: Schema.Array(ObservedAttachment),
  chatGuid: ChatGuid,
  handle: Schema.String,
  isFromMe: Schema.Literal(false),
  messageGuid: MessageGuid,
  rowId: MessagesRowId,
  sentAt: Schema.DateFromString,
  service: Schema.Literal('iMessage'),
  text: Schema.NullOr(Schema.String),
});
export type ObservedMessage = typeof ObservedMessage.Type;
