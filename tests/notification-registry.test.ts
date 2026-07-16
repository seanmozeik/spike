import { expect, it } from 'vitest';

import { makeNotificationRegistry } from '../src/codex/notification-registry';

it('replays notifications that arrive before a turn listener is installed', async () => {
  const registry = makeNotificationRegistry(10);
  const seen: string[] = [];
  registry.publish({ method: 'turn/completed', params: { turn: { id: 'turn-1' } } });
  registry.subscribe((notification) => {
    seen.push(notification.method);
  });
  await Promise.resolve();
  expect(seen).toEqual(['turn/completed']);
});

it('does not replay to a listener removed before the replay microtask', async () => {
  const registry = makeNotificationRegistry(10);
  const seen: string[] = [];
  registry.publish({ method: 'turn/completed', params: {} });
  const unsubscribe = registry.subscribe((notification) => {
    seen.push(notification.method);
  });
  unsubscribe();
  await Promise.resolve();
  expect(seen).toEqual([]);
});
