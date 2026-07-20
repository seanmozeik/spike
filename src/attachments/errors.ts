import { Schema } from 'effect';

class AttachmentStagingPermissionError extends Schema.TaggedErrorClass<AttachmentStagingPermissionError>()(
  'AttachmentStagingPermissionError',
  { message: Schema.String },
) {}

class SafeStagingError extends Error {
  override readonly name = 'SafeStagingError';
}

const fileErrorCode = (cause: unknown): null | string =>
  typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : null;

const isFilePermissionDenied = (cause: unknown): boolean => {
  const code = fileErrorCode(cause);
  return code === 'EACCES' || code === 'EPERM';
};

export {
  AttachmentStagingPermissionError,
  fileErrorCode,
  isFilePermissionDenied,
  SafeStagingError,
};
