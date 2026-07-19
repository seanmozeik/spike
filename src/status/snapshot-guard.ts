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

const isStatusSnapshotShape = (value: unknown): boolean =>
  isObject(value) &&
  value['ok'] === true &&
  isObject(value['service']) &&
  isObject(value['appServer']) &&
  hasValidOutages(value);

export { isStatusSnapshotShape };
