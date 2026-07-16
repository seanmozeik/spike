import { Schema } from 'effect';

class MessagesDeliveryError extends Schema.TaggedErrorClass<MessagesDeliveryError>()(
  'MessagesDeliveryError',
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

export { MessagesDeliveryError };
