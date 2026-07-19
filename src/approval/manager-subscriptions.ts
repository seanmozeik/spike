import type { JsonRpcNotification } from '../codex/rpc';
import { APPROVAL_METHODS } from '../codex/rpc-server-request';
import type { JsonRpcId } from '../codex/server-request-registry';
import type { ApprovalContext } from './manager-types';

const resolvedRequestId = (notification: JsonRpcNotification): JsonRpcId | null => {
  if (notification.method !== 'serverRequest/resolved') {
    return null;
  }
  const { params } = notification;
  if (typeof params !== 'object' || params === null || !('requestId' in params)) {
    return null;
  }
  const { requestId } = params;
  return typeof requestId === 'number' || typeof requestId === 'string' ? requestId : null;
};

const subscribeRuntime = (context: ApprovalContext): readonly (() => void)[] => [
  context.options.runtime.addServerRequestListener(APPROVAL_METHODS, (request) => {
    context.pendingEvents.push({ kind: 'Request', request });
    context.options.onWake?.();
  }),
  context.options.runtime.addNotificationListener((notification) => {
    const id = resolvedRequestId(notification);
    if (id !== null) {
      context.pendingEvents.push({ id, kind: 'Resolved' });
      context.options.onWake?.();
    }
  }),
  context.options.runtime.addConnectionCloseListener(() => {
    context.pendingEvents.push({ kind: 'ConnectionClosed' });
    context.options.onWake?.();
  }),
];

export { subscribeRuntime };
