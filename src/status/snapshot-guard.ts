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

const isStatusSnapshotShape = (value: unknown): boolean =>
  isObject(value) &&
  value['ok'] === true &&
  isObject(value['service']) &&
  isObject(value['appServer']) &&
  hasValidAttachments(value) &&
  hasValidOutages(value);

export { isStatusSnapshotShape };
