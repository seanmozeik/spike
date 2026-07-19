import { isObject } from './object-guard';

const MAX_CAUSE_DEPTH = 8;

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
    const message = singleErrorMessage(current);
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

export { errorMessageChain };
