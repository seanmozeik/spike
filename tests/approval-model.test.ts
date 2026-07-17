import { expect, it } from 'vitest';

import { decodeApprovalRequest, decisionResponse } from '../src/approval/model';

const now = new Date('2026-07-14T12:00:00.000Z');
const expiresAt = new Date('2026-07-14T12:10:00.000Z');

it('maps current and legacy decisions to their method-specific response shapes', () => {
  const cases = [
    {
      method: 'item/commandExecution/requestApproval',
      no: { decision: 'decline' },
      params: {
        availableDecisions: ['accept', 'decline'],
        command: 'ls',
        itemId: 'command',
        startedAtMs: now.getTime(),
        threadId: 'thread',
        turnId: 'turn',
      },
      yes: { decision: 'accept' },
    },
    {
      method: 'item/fileChange/requestApproval',
      no: { decision: 'decline' },
      params: { itemId: 'patch', startedAtMs: now.getTime(), threadId: 'thread', turnId: 'turn' },
      yes: { decision: 'accept' },
    },
    {
      method: 'execCommandApproval',
      no: { decision: 'denied' },
      params: {
        approvalId: null,
        callId: 'command',
        command: ['ls'],
        conversationId: 'thread',
        cwd: '/tmp',
        reason: null,
      },
      yes: { decision: 'approved' },
    },
    {
      method: 'applyPatchApproval',
      no: { decision: 'denied' },
      params: {
        callId: 'patch',
        conversationId: 'thread',
        fileChanges: { '/tmp/a.ts': { type: 'add' } },
        grantRoot: null,
        reason: null,
      },
      yes: { decision: 'approved' },
    },
  ] as const;
  for (const item of cases) {
    const decoded = decodeApprovalRequest(
      { id: item.method, method: item.method, params: item.params },
      now,
      expiresAt,
    );
    expect(decoded.valid).toBe(true);
    if (decoded.valid) {
      expect(decisionResponse(decoded.request, 'yes')).toStrictEqual(item.yes);
      expect(decisionResponse(decoded.request, 'no')).toStrictEqual(item.no);
    }
  }
});

it('grants only the requested generic permissions for one turn and denies with an empty grant', () => {
  const decoded = decodeApprovalRequest(
    {
      id: 5,
      method: 'item/permissions/requestApproval',
      params: {
        cwd: '/workspace',
        itemId: 'permissions',
        permissions: { fileSystem: null, network: { enabled: true } },
        reason: 'network access',
        startedAtMs: now.getTime(),
        threadId: 'thread',
        turnId: 'turn',
      },
    },
    now,
    expiresAt,
  );
  expect(decoded.valid).toBe(true);
  if (decoded.valid) {
    expect(decisionResponse(decoded.request, 'yes')).toStrictEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
    });
    expect(decisionResponse(decoded.request, 'no')).toStrictEqual({
      permissions: {},
      scope: 'turn',
    });
  }
});

it('fails malformed payloads and unavailable one-shot decisions closed', () => {
  expect(
    decodeApprovalRequest(
      { id: 1, method: 'item/commandExecution/requestApproval', params: {} },
      now,
      expiresAt,
    ),
  ).toStrictEqual({ denial: { decision: 'decline' }, valid: false });
  expect(
    decodeApprovalRequest(
      {
        id: 2,
        method: 'item/commandExecution/requestApproval',
        params: {
          availableDecisions: ['cancel'],
          itemId: 'command',
          startedAtMs: now.getTime(),
          threadId: 'thread',
          turnId: 'turn',
        },
      },
      now,
      expiresAt,
    ),
  ).toStrictEqual({ denial: { decision: 'decline' }, valid: false });
});
