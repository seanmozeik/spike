import { Schema } from 'effect';

import type { CodexServerRequest, JsonRpcId } from '../codex/server-request-registry';
import { ApprovalId } from '../domain/ids';
import {
  ApprovalMethod,
  CommandApprovalParams,
  FileChangeApprovalParams,
  LegacyExecApprovalParams,
  LegacyPatchApprovalParams,
  PermissionsApprovalParams,
} from './schema';

type ApprovalMethod = typeof ApprovalMethod.Type;

type ApprovalOperation = 'Command' | 'FileChange' | 'Permissions';
type ApprovalState = 'Approved' | 'Cancelled' | 'Denied' | 'Expired' | 'Orphaned' | 'Pending';
type ApprovalDecision = 'no' | 'yes';

interface ApprovalRequest {
  readonly availableDecisions: readonly unknown[] | null;
  readonly command: string | null;
  readonly cwd: string | null;
  readonly expiresAt: Date;
  readonly filePaths: readonly string[];
  readonly id: ApprovalId;
  readonly itemId: string | null;
  readonly method: ApprovalMethod;
  readonly operation: ApprovalOperation;
  readonly params: unknown;
  readonly reason: string | null;
  readonly requestedAt: Date;
  readonly rpcRequestId: JsonRpcId;
  readonly threadId: string | null;
  readonly turnId: string | null;
}

type DecodeApprovalResult =
  | { readonly request: ApprovalRequest; readonly valid: true }
  | { readonly denial: unknown; readonly valid: false };

const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown): A =>
  Schema.decodeUnknownSync(schema)(value);

const strings = (value: readonly string[]): string => value.join(' ');

const permissionGrant = (
  params: typeof PermissionsApprovalParams.Type,
): Record<string, unknown> => ({
  ...(params.permissions.fileSystem === null ? {} : { fileSystem: params.permissions.fileSystem }),
  ...(params.permissions.network === null ? {} : { network: params.permissions.network }),
});

const decisionResponse = (
  request: Pick<ApprovalRequest, 'method' | 'params'>,
  decision: ApprovalDecision | 'cancelled' | 'expired',
): unknown => {
  if (request.method === 'item/permissions/requestApproval') {
    const params = decode(PermissionsApprovalParams, request.params);
    return { permissions: decision === 'yes' ? permissionGrant(params) : {}, scope: 'turn' };
  }
  if (request.method.startsWith('item/')) {
    if (decision === 'yes') {
      return { decision: 'accept' };
    }
    if (decision === 'cancelled') {
      return { decision: 'cancel' };
    }
    return { decision: 'decline' };
  }
  if (decision === 'yes') {
    return { decision: 'approved' };
  }
  if (decision === 'expired') {
    return { decision: 'timed_out' };
  }
  if (decision === 'cancelled') {
    return { decision: 'abort' };
  }
  return { decision: 'denied' };
};

const safeDenial = (method: string): unknown => {
  if (method === 'item/permissions/requestApproval') {
    return { permissions: {}, scope: 'turn' };
  }
  if (method.startsWith('item/')) {
    return { decision: 'decline' };
  }
  return { decision: 'denied' };
};

const oneShotDecisionsAvailable = (value: readonly unknown[] | null): boolean =>
  value === null || (value.includes('accept') && value.includes('decline'));

interface DecodeContext {
  readonly envelope: CodexServerRequest;
  readonly expiresAt: Date;
  readonly id: ApprovalId;
  readonly method: ApprovalMethod;
  readonly now: Date;
}

const isFileChangeParams = (
  params: typeof CommandApprovalParams.Type | typeof FileChangeApprovalParams.Type,
): params is typeof FileChangeApprovalParams.Type => 'grantRoot' in params;

const currentRequest = (
  context: DecodeContext,
  params: typeof CommandApprovalParams.Type | typeof FileChangeApprovalParams.Type,
  operation: ApprovalOperation,
): ApprovalRequest => ({
  availableDecisions: 'availableDecisions' in params ? (params.availableDecisions ?? null) : null,
  command: 'command' in params ? (params.command ?? null) : null,
  cwd: isFileChangeParams(params) ? (params.grantRoot ?? null) : (params.cwd ?? null),
  expiresAt: context.expiresAt,
  filePaths:
    isFileChangeParams(params) && typeof params.grantRoot === 'string' ? [params.grantRoot] : [],
  id: context.id,
  itemId: params.itemId,
  method: context.method,
  operation,
  params,
  reason: params.reason ?? null,
  requestedAt: new Date(params.startedAtMs),
  rpcRequestId: context.envelope.id,
  threadId: params.threadId,
  turnId: params.turnId,
});

const decodeCommand = (context: DecodeContext): DecodeApprovalResult => {
  const params = decode(CommandApprovalParams, context.envelope.params);
  const decisions = params.availableDecisions ?? null;
  if (!oneShotDecisionsAvailable(decisions)) {
    return { denial: safeDenial(context.method), valid: false };
  }
  return { request: currentRequest(context, params, 'Command'), valid: true };
};

const decodePermissions = (context: DecodeContext): DecodeApprovalResult => {
  const params = decode(PermissionsApprovalParams, context.envelope.params);
  return {
    request: {
      availableDecisions: null,
      command: null,
      cwd: params.cwd,
      expiresAt: context.expiresAt,
      filePaths: [],
      id: context.id,
      itemId: params.itemId,
      method: context.method,
      operation: 'Permissions',
      params,
      reason: params.reason,
      requestedAt: new Date(params.startedAtMs),
      rpcRequestId: context.envelope.id,
      threadId: params.threadId,
      turnId: params.turnId,
    },
    valid: true,
  };
};

const decodeLegacy = (context: DecodeContext): DecodeApprovalResult => {
  if (context.method === 'execCommandApproval') {
    const params = decode(LegacyExecApprovalParams, context.envelope.params);
    return {
      request: {
        availableDecisions: null,
        command: strings(params.command),
        cwd: params.cwd,
        expiresAt: context.expiresAt,
        filePaths: [],
        id: context.id,
        itemId: params.callId,
        method: context.method,
        operation: 'Command',
        params,
        reason: params.reason,
        requestedAt: context.now,
        rpcRequestId: context.envelope.id,
        threadId: params.conversationId,
        turnId: null,
      },
      valid: true,
    };
  }
  const params = decode(LegacyPatchApprovalParams, context.envelope.params);
  return {
    request: {
      availableDecisions: null,
      command: null,
      cwd: params.grantRoot,
      expiresAt: context.expiresAt,
      filePaths: Object.keys(params.fileChanges),
      id: context.id,
      itemId: params.callId,
      method: context.method,
      operation: 'FileChange',
      params,
      reason: params.reason,
      requestedAt: context.now,
      rpcRequestId: context.envelope.id,
      threadId: params.conversationId,
      turnId: null,
    },
    valid: true,
  };
};

const decodeApprovalRequest = (
  envelope: CodexServerRequest,
  now: Date,
  expiresAt: Date,
): DecodeApprovalResult => {
  try {
    const method = decode(ApprovalMethod, envelope.method);
    const context = { envelope, expiresAt, id: ApprovalId.make(crypto.randomUUID()), method, now };
    if (method === 'item/commandExecution/requestApproval') {
      return decodeCommand(context);
    }
    if (method === 'item/fileChange/requestApproval') {
      return {
        request: currentRequest(
          context,
          decode(FileChangeApprovalParams, envelope.params),
          'FileChange',
        ),
        valid: true,
      };
    }
    if (method === 'item/permissions/requestApproval') {
      return decodePermissions(context);
    }
    return decodeLegacy(context);
  } catch {
    return { denial: safeDenial(envelope.method), valid: false };
  }
};

const permissionSummary = (request: ApprovalRequest): string => {
  if (request.method !== 'item/permissions/requestApproval') {
    return '';
  }
  return JSON.stringify(decode(PermissionsApprovalParams, request.params).permissions);
};

export { ApprovalMethod, decodeApprovalRequest, decisionResponse, permissionSummary, safeDenial };
export type {
  ApprovalDecision,
  ApprovalOperation,
  ApprovalRequest,
  ApprovalState,
  DecodeApprovalResult,
};
