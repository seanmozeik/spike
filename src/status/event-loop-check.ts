import { isObject } from '../object-guard';

type EventLoopCheckState = 'fail' | 'pass' | 'warn';

interface EventLoopCheck {
  readonly detail: string;
  readonly name: string;
  readonly state: EventLoopCheckState;
}

const numericField = (value: Record<string, unknown>, key: string): number =>
  typeof value[key] === 'number' ? value[key] : 0;

const checkState = (
  watcher: Record<string, unknown> | null,
  messagesPolls: number,
  reconciliationFailures: number,
): EventLoopCheckState => {
  if (messagesPolls === 0) {
    return 'fail';
  }
  return reconciliationFailures > 0 ||
    watcher === null ||
    watcher['active'] !== true ||
    numericField(watcher, 'failures') > 0
    ? 'warn'
    : 'pass';
};

export const eventLoopCheck = (value: unknown): EventLoopCheck => {
  if (!isObject(value)) {
    return { detail: 'diagnostics unavailable', name: 'Messages event loop', state: 'warn' };
  }
  const watcher = isObject(value['watcher']) ? value['watcher'] : null;
  const messages = isObject(value['messages']) ? value['messages'] : {};
  const reconciliation = isObject(value['reconciliation']) ? value['reconciliation'] : {};
  const filesystem = isObject(value['filesystem']) ? value['filesystem'] : {};
  const active = watcher?.['active'] === true;
  const polls = numericField(messages, 'polls');
  const failures = numericField(reconciliation, 'failures');
  const watcherFailures = watcher === null ? 0 : numericField(watcher, 'failures');
  return {
    detail: `${String(polls)} liveness polls, ${active ? 'watching' : 'not watching'}, ${String(numericField(filesystem, 'wakes'))} watcher wakes, ${String(numericField(messages, 'queries'))} queries, ${String(numericField(messages, 'passes'))} passes, ${String(failures)} reconciliation failures, ${String(watcherFailures)} watcher failures`,
    name: 'Messages event loop',
    state: checkState(watcher, polls, failures),
  };
};
