const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasValidOutages = (value: Record<string, unknown>): boolean => {
  const { outages } = value;
  return (
    outages === undefined ||
    (isObject(outages) &&
      Array.isArray(outages['open']) &&
      outages['open'].every((kind) => typeof kind === 'string'))
  );
};

const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';

const hasValidAttachments = (value: Record<string, unknown>): boolean => {
  const { attachments } = value;
  return (
    attachments === undefined ||
    (isObject(attachments) &&
      typeof attachments['available'] === 'boolean' &&
      isNullableString(attachments['blockedSince']) &&
      isNullableString(attachments['diagnostic']))
  );
};

const hasValidCounter = (value: unknown, fields: readonly string[]): boolean =>
  isObject(value) && fields.every((field) => typeof value[field] === 'number');

const hasValidEventLoop = (value: Record<string, unknown>): boolean => {
  const { eventLoop } = value;
  if (eventLoop === undefined) {
    return true;
  }
  if (!isObject(eventLoop) || typeof eventLoop['startedAt'] !== 'string') {
    return false;
  }
  const { filesystem } = eventLoop;
  const { messages } = eventLoop;
  const { reconciliation } = eventLoop;
  const { watcher } = eventLoop;
  return (
    hasValidCounter(filesystem, ['events', 'wakes']) &&
    hasValidCounter(messages, ['passes', 'queries']) &&
    hasValidCounter(reconciliation, ['failures', 'passes']) &&
    (watcher === null ||
      (isObject(watcher) &&
        typeof watcher['active'] === 'boolean' &&
        typeof watcher['failures'] === 'number'))
  );
};

const isStatusSnapshotShape = (value: unknown): boolean =>
  isObject(value) &&
  value['ok'] === true &&
  isObject(value['service']) &&
  isObject(value['appServer']) &&
  hasValidAttachments(value) &&
  hasValidEventLoop(value) &&
  hasValidOutages(value);

export { isStatusSnapshotShape };
