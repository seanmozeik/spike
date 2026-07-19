import type { Effect } from 'effect';

import type { StagedImageAttachment } from '../attachments/model';
import type { CodexThreadId, CodexTurnId } from '../domain/ids';
import type { CodexRuntimeError, GenerationBroken } from '../errors';
import type { ClassifiedOutput } from './output-classifier';
import type { ThreadSnapshot } from './reconcile';
import type { JsonRpcNotification } from './rpc';
import type { JsonRpcError } from './rpc-types';
import type { CodexServerRequest, JsonRpcId } from './server-request-registry';

interface StartTurnOptions {
  readonly attachments: readonly StagedImageAttachment[];
  readonly clientUserMessageId: string;
  readonly input: string;
  readonly threadId: CodexThreadId;
}

interface SteerTurnOptions extends StartTurnOptions {
  readonly expectedTurnId: CodexTurnId;
}

interface TurnEventHandlers {
  readonly onAcknowledgement: (text: string) => void;
  readonly onCompactionStarted: (itemId: string) => void;
}

interface CodexRuntime {
  readonly accountId: string;
  readonly addConnectionCloseListener: (listener: () => void) => () => void;
  readonly addNotificationListener: (
    listener: (notification: JsonRpcNotification) => void,
  ) => () => void;
  readonly addServerRequestListener: (
    methods: ReadonlySet<string>,
    listener: (request: CodexServerRequest) => void,
  ) => () => void;
  readonly archiveThread: (threadId: CodexThreadId) => Effect.Effect<void, CodexRuntimeError>;
  readonly close: () => Promise<void>;
  readonly health: Effect.Effect<void, CodexRuntimeError>;
  readonly loadedThreads: Effect.Effect<readonly CodexThreadId[], CodexRuntimeError>;
  readonly rateLimits: Effect.Effect<unknown, CodexRuntimeError>;
  readonly respondToServerRequest: (id: JsonRpcId, result: unknown) => Promise<void>;
  readonly respondToServerRequestError: (id: JsonRpcId, error: JsonRpcError) => Promise<void>;
  readonly readThread: (
    threadId: CodexThreadId,
  ) => Effect.Effect<ThreadSnapshot, CodexRuntimeError | GenerationBroken>;
  readonly resumeThread: (
    threadId: CodexThreadId,
  ) => Effect.Effect<void, CodexRuntimeError | GenerationBroken>;
  readonly interruptTurn: (
    threadId: CodexThreadId,
    turnId: CodexTurnId,
  ) => Effect.Effect<void, CodexRuntimeError>;
  readonly startThread: Effect.Effect<CodexThreadId, CodexRuntimeError>;
  readonly startTurn: (options: StartTurnOptions) => Effect.Effect<CodexTurnId, CodexRuntimeError>;
  readonly steerTurn: (options: SteerTurnOptions) => Effect.Effect<void, CodexRuntimeError>;
  readonly usage: Effect.Effect<unknown, CodexRuntimeError>;
  readonly waitForTurn: (
    threadId: CodexThreadId,
    turnId: CodexTurnId,
    handlers: TurnEventHandlers,
  ) => Effect.Effect<ClassifiedOutput, CodexRuntimeError>;
}

export type { CodexRuntime, StartTurnOptions, SteerTurnOptions, TurnEventHandlers };
