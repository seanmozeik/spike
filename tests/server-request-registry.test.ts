import { expect, it } from 'vitest';

import { makeServerRequestRegistry } from '../src/codex/server-request-registry';

it('routes and replays server requests only to the listener that owns the method', async () => {
  const registry = makeServerRequestRegistry();
  registry.publish({ id: 1, method: 'item/commandExecution/requestApproval', params: {} });
  const approvals: number[] = [];
  const schedules: number[] = [];
  registry.subscribe(new Set(['currentTime/read', 'item/tool/call']), ({ id }) => {
    schedules.push(Number(id));
  });
  registry.subscribe(new Set(['item/commandExecution/requestApproval']), ({ id }) => {
    approvals.push(Number(id));
  });
  await Bun.sleep(0);
  expect(approvals).toStrictEqual([1]);
  expect(schedules).toStrictEqual([]);

  registry.publish({ id: 2, method: 'item/tool/call', params: {} });
  expect(approvals).toStrictEqual([1]);
  expect(schedules).toStrictEqual([2]);
});
