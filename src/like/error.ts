import { Schema } from 'effect';

class LikeNativeError extends Schema.TaggedErrorClass<LikeNativeError>()('LikeNativeError', {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

export { LikeNativeError };
