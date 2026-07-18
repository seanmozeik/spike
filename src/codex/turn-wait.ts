import { Effect } from 'effect';

import type { CodexThreadId, CodexTurnId } from '../domain/ids';
import { CodexRuntimeError } from '../errors';
import { collectOutput, type ClassifiedOutput, type CodexNotification } from './output-classifier';
import type { JsonRpcNotification, RpcHandle } from './rpc';
import type { TurnEventHandlers } from './runtime-types';

const TURN_WAIT_TIMEOUT_MS = 3_600_000;
const noOp = (): void => undefined;

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

const connectionClosedError = (turnId: CodexTurnId): CodexRuntimeError =>
  new CodexRuntimeError({
    cause: new Error(`Codex connection closed while waiting for turn ${turnId}`),
    message: 'Codex turn/wait failed because the app-server connection closed',
    operation: 'turn/wait',
  });

interface TurnWaitState {
  acknowledged: boolean;
  readonly compactions: Set<string>;
  readonly notifications: CodexNotification[];
}

const recordNotification = (
  state: TurnWaitState,
  notification: JsonRpcNotification,
  threadId: CodexThreadId,
  turnId: CodexTurnId,
  handlers: TurnEventHandlers,
): Effect.Effect<ClassifiedOutput, CodexRuntimeError> | null => {
  if (!belongsToTurn(notification, threadId, turnId)) {
    return null;
  }
  state.notifications.push(notification);
  const compacting = compactionItemId(notification);
  if (compacting !== null && !state.compactions.has(compacting)) {
    state.compactions.add(compacting);
    handlers.onCompactionStarted(compacting);
  }
  const output = collectOutput(state.notifications, false);
  if (!state.acknowledged && output.acknowledgement !== null) {
    state.acknowledged = true;
    handlers.onAcknowledgement(output.acknowledgement);
  }
  if (notification.method !== 'turn/completed') {
    return null;
  }
  return turnSucceeded(notification)
    ? Effect.succeed(collectOutput(state.notifications, true))
    : Effect.fail(failedCompletion(notification));
};

const waitForTurn = (
  handle: RpcHandle,
  threadId: CodexThreadId,
  turnId: CodexTurnId,
  handlers: TurnEventHandlers,
): Effect.Effect<ClassifiedOutput, CodexRuntimeError> =>
  Effect.callback<ClassifiedOutput, CodexRuntimeError>((resume) => {
    const state: TurnWaitState = {
      acknowledged: false,
      compactions: new Set<string>(),
      notifications: [],
    };
    const timer: { timeout?: ReturnType<typeof setTimeout> } = {};
    let settled = false;
    let removeNotifications = noOp;
    let removeClose = noOp;
    const cleanup = (): void => {
      clearTimeout(timer.timeout);
      removeNotifications();
      removeClose();
    };
    const settle = (result: Effect.Effect<ClassifiedOutput, CodexRuntimeError>): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resume(result);
    };
    removeNotifications = handle.addNotificationListener((notification) => {
      if (settled) {
        return;
      }
      const result = recordNotification(state, notification, threadId, turnId, handlers);
      if (result !== null) {
        settle(result);
      }
    });
    removeClose = handle.addConnectionCloseListener(() => {
      settle(Effect.fail(connectionClosedError(turnId)));
    });
    timer.timeout = setTimeout(() => {
      settle(Effect.fail(timeoutError(turnId)));
    }, TURN_WAIT_TIMEOUT_MS);
    return Effect.sync(() => {
      settled = true;
      cleanup();
    });
  });

export { waitForTurn };
