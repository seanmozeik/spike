import { type CodexRuntimeError, WaitingForAuthentication, WaitingForCapacity } from '../errors';

type CodexAvailabilityError = CodexRuntimeError | WaitingForAuthentication | WaitingForCapacity;

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    return `${cause.name} ${cause.message} ${describeCause(cause.cause)}`;
  }
  if (typeof cause === 'object' && cause !== null) {
    try {
      return JSON.stringify(cause);
    } catch {
      return Object.prototype.toString.call(cause);
    }
  }
  if (
    typeof cause === 'string' ||
    typeof cause === 'number' ||
    typeof cause === 'boolean' ||
    typeof cause === 'bigint' ||
    typeof cause === 'symbol'
  ) {
    return String(cause);
  }
  if (typeof cause === 'function') {
    return cause.name;
  }
  return '';
};

const classifyCodexAvailability = (error: CodexRuntimeError): CodexAvailabilityError => {
  const description = `${error.message} ${describeCause(error.cause)}`;
  if (
    /\b(?:401|unauthori[sz]ed|invalid (?:auth|authentication|token)|authentication (?:failed|required)|login required)\b/iu.test(
      description,
    )
  ) {
    return new WaitingForAuthentication({
      message: 'the active Codex account needs authentication',
    });
  }
  if (/\b(?:429|rate.?limit|usage.?limit|capacity|quota|too many requests)\b/iu.test(description)) {
    return new WaitingForCapacity({ resetAt: null });
  }
  return error;
};

export { classifyCodexAvailability };
export type { CodexAvailabilityError };
