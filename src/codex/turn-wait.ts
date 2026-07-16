import { Effect } from 'effect';

import type { CodexThreadId, CodexTurnId } from '../domain/ids';
import { CodexRuntimeError } from '../errors';
import { collectOutput, type ClassifiedOutput, type CodexNotification } from './output-classifier';
import type { JsonRpcNotification, RpcHandle } from './rpc';
import type { TurnEventHandlers } from './runtime-types';

const TURN_WAIT_TIMEOUT_MS = 3_600_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const belongsToTurn = (
  notification: JsonRpcNotification,
  threadId: string,
  turnId: string,
): boolean => {
  if (!isObject(notification.params)) {
    return false;
  }
  const notificationThread = notification.params['threadId'];
  const directTurn = notification.params['turnId'];
  const nestedTurn = isObject(notification.params['turn'])
    ? notification.params['turn']['id']
    : null;
  return notificationThread === threadId && (directTurn === turnId || nestedTurn === turnId);
};

const turnSucceeded = (notification: JsonRpcNotification): boolean =>
  isObject(notification.params) &&
  isObject(notification.params['turn']) &&
  notification.params['turn']['status'] === 'completed';

const compactionItemId = (notification: JsonRpcNotification): string | null => {
  if (notification.method !== 'item/started' || !isObject(notification.params)) {
    return null;
  }
  const { item } = notification.params;
  return isObject(item) && item['type'] === 'contextCompaction' && typeof item['id'] === 'string'
    ? item['id']
    : null;
};

const timeoutError = (turnId: CodexTurnId): CodexRuntimeError =>
  new CodexRuntimeError({
    cause: new Error(`turn ${turnId} timed out after ${String(TURN_WAIT_TIMEOUT_MS)}ms`),
    message: 'Codex turn/wait failed',
    operation: 'turn/wait',
  });

const failedCompletion = (notification: JsonRpcNotification): CodexRuntimeError =>
  new CodexRuntimeError({
    cause: notification.params,
    message: 'Codex turn/completed failed',
    operation: 'turn/completed',
  });

const waitForTurn = (
  handle: RpcHandle,
  threadId: CodexThreadId,
  turnId: CodexTurnId,
  handlers: TurnEventHandlers,
): Effect.Effect<ClassifiedOutput, CodexRuntimeError> =>
  Effect.callback<ClassifiedOutput, CodexRuntimeError>((resume) => {
    const notifications: CodexNotification[] = [];
    const compactions = new Set<string>();
    const timer: { timeout?: ReturnType<typeof setTimeout> } = {};
    let acknowledged = false;
    let settled = false;
    const remove = handle.addNotificationListener((notification) => {
      if (settled || !belongsToTurn(notification, threadId, turnId)) {
        return;
      }
      notifications.push(notification);
      const compacting = compactionItemId(notification);
      if (compacting !== null && !compactions.has(compacting)) {
        compactions.add(compacting);
        handlers.onCompactionStarted(compacting);
      }
      const output = collectOutput(notifications, false);
      if (!acknowledged && output.acknowledgement !== null) {
        acknowledged = true;
        handlers.onAcknowledgement(output.acknowledgement);
      }
      if (notification.method !== 'turn/completed') {
        return;
      }
      settled = true;
      clearTimeout(timer.timeout);
      remove();
      resume(
        turnSucceeded(notification)
          ? Effect.succeed(collectOutput(notifications, true))
          : Effect.fail(failedCompletion(notification)),
      );
    });
    timer.timeout = setTimeout(() => {
      settled = true;
      remove();
      resume(Effect.fail(timeoutError(turnId)));
    }, TURN_WAIT_TIMEOUT_MS);
    return Effect.sync(() => {
      clearTimeout(timer.timeout);
      remove();
    });
  });

export { waitForTurn };
