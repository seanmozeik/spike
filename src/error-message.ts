import { plainLogText } from './logging/plain-text';
import { isObject } from './object-guard';

const MAX_CAUSE_DEPTH = 8;
const SAFE_ERROR_MESSAGE_LIMIT = 300;
const SAFE_ERROR_TAG_LIMIT = 80;
const SECRET = /\b(?:Bearer\s+\S+|sk-[\w-]{8,}|ghp_[\w-]{8,})\b/giu;

const stringProperty = (value: Record<string, unknown>, key: string): string | undefined => {
  try {
    const property = value[key];
    return typeof property === 'string' && property.trim() !== '' ? property.trim() : undefined;
  } catch {
    return undefined;
  }
};

const singleErrorMessage = (value: unknown): string => {
  if (isObject(value)) {
    const message = stringProperty(value, 'message');
    if (message !== undefined) {
      return message;
    }
  }
  try {
    return String(value);
  } catch {
    return 'unknown error';
  }
};

const nestedCause = (value: Record<string, unknown>): unknown => {
  try {
    return value['cause'];
  } catch {
    return undefined;
  }
};

const guardedErrorName = (value: Record<string, unknown>): string | undefined => {
  try {
    if (!(value instanceof Error)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return stringProperty(value, 'name');
};

const nestedErrorMessage = (value: unknown): string | undefined => {
  if (!isObject(value)) {
    return undefined;
  }
  const message = stringProperty(value, 'message') ?? stringProperty(value, '_tag');
  if (message !== undefined) {
    return message;
  }
  const name = guardedErrorName(value);
  return name === 'Error' ? undefined : name;
};

const errorMessageChain = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const messages: string[] = [];
  let current: unknown = value;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (isObject(current)) {
      if (seen.has(current)) {
        break;
      }
      seen.add(current);
    }
    const message = depth === 0 ? singleErrorMessage(current) : nestedErrorMessage(current);
    if (message === undefined) {
      break;
    }
    if (messages.at(-1) !== message) {
      messages.push(message);
    }
    if (!isObject(current)) {
      break;
    }
    const cause = nestedCause(current);
    if (cause === undefined) {
      break;
    }
    current = cause;
  }
  return messages.join(': ');
};

const safeText = (text: string, limit: number): string =>
  plainLogText(text)
    .replaceAll(SECRET, '[redacted]')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);

const safeErrorDiagnostic = (value: unknown): string =>
  safeText(errorMessageChain(value), SAFE_ERROR_MESSAGE_LIMIT);

const safeErrorTag = (value: unknown): string => {
  const candidate = isObject(value)
    ? (stringProperty(value, '_tag') ?? guardedErrorName(value))
    : undefined;
  return safeText(candidate ?? 'UnknownError', SAFE_ERROR_TAG_LIMIT) || 'UnknownError';
};

export { errorMessageChain, safeErrorDiagnostic, safeErrorTag };
