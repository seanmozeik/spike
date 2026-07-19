const MAX_CAUSE_DEPTH = 8;

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

const stringProperty = (value: object, key: string): string | undefined => {
  try {
    const property = Reflect.get(value, key) as unknown;
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

const nestedCause = (value: object): unknown => {
  try {
    return Reflect.get(value, 'cause');
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
