import { expect, it } from 'vitest';

import { routeServerRequest } from '../src/codex/rpc-server-request';

it('publishes every current and legacy approval request without answering it', () => {
  const published: unknown[] = [];
  const written: unknown[] = [];
  for (const method of [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ]) {
    expect(
      routeServerRequest(
        { id: method, method, params: {} },
        (request) => {
          published.push(request);
        },
        (value) => {
          written.push(value);
        },
      ),
    ).toBe(true);
  }
  expect(published).toHaveLength(5);
  expect(written).toHaveLength(0);
});

it('rejects unknown server requests with method-not-found', () => {
  const written: unknown[] = [];
  expect(
    routeServerRequest(
      { id: 9, method: 'unknown/request', params: {} },
      (): void => undefined,
      (value) => {
        written.push(value);
      },
    ),
  ).toBe(true);
  expect(written).toStrictEqual([
    {
      error: { code: -32_601, message: 'method unknown/request not implemented' },
      id: 9,
      jsonrpc: '2.0',
    },
  ]);
});
