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

const isNullableString = (value: unknown): value is null | string =>
  value === null || typeof value === 'string';

interface ScheduleDiagnostics {
  readonly active: number;
  readonly cancelled: number;
  readonly completed: number;
  readonly nextDueAt: string | null;
  readonly paused: number;
  readonly queued: number;
  readonly running: number;
}

const isCounter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const readScheduleDiagnostics = (value: unknown): ScheduleDiagnostics | null => {
  if (!isObject(value)) {
    return null;
  }
  const { active, cancelled, completed, nextDueAt, paused, queued, running } = value;
  if (
    !isCounter(active) ||
    !isCounter(cancelled) ||
    !isCounter(completed) ||
    !isCounter(paused) ||
    !isCounter(queued) ||
    !isCounter(running) ||
    !isNullableString(nextDueAt)
  ) {
    return null;
  }
  return { active, cancelled, completed, nextDueAt, paused, queued, running };
};

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

const hasValidSchedules = (value: Record<string, unknown>): boolean => {
  const { schedules } = value;
  return schedules === undefined || readScheduleDiagnostics(schedules) !== null;
};

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
  hasValidSchedules(value) &&
  hasValidEventLoop(value) &&
  hasValidOutages(value);

export { isStatusSnapshotShape, readScheduleDiagnostics };
export type { ScheduleDiagnostics };
