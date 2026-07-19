import { Effect } from 'effect';
import { expect, it } from 'vitest';

import { initializeRpc } from '../src/codex/rpc';
import type { RpcHandle } from '../src/codex/rpc-types';
import { spikeVersion } from '../src/version';

const removeListener = (): void => undefined;

it('identifies the installed Spike version to the Codex app-server', async () => {
  const requests: { readonly method: string; readonly params: unknown }[] = [];
  const notifications: { readonly method: string; readonly params: unknown }[] = [];
  const handle = {
    addConnectionCloseListener: (_listener: () => void): (() => void) => removeListener,
    addNotificationListener: (): (() => void) => removeListener,
    addServerRequestListener: (): (() => void) => removeListener,
    close: (): Promise<void> => Promise.resolve(),
    notify: (method: string, params?: unknown): Promise<void> => {
      notifications.push({ method, params });
      return Promise.resolve();
    },
    request: (method: string, params?: unknown): Promise<unknown> => {
      requests.push({ method, params });
      return Promise.resolve({});
    },
    respondToServerRequest: (): Promise<void> => Promise.resolve(),
  } satisfies RpcHandle;

  await Effect.runPromise(initializeRpc(handle));

  expect(requests).toContainEqual({
    method: 'initialize',
    params: {
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ['item/agentMessage/delta'],
      },
      clientInfo: { name: 'spike_agent', title: 'Spike iMessage Agent', version: spikeVersion },
    },
  });
  expect(notifications).toStrictEqual([{ method: 'initialized', params: undefined }]);
});
