import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { Effect, Result } from 'effect';

import type { CodexRuntime } from '../codex/runtime';
import { compactError, type DeliveryService } from '../delivery/service';
import type { ChatGuid } from '../domain/ids';
import { SpikeRuntimeError } from '../errors';
import type { CodexJournal } from '../journal/codex-journal';
import type { SchedulerJournal } from '../journal/scheduler-journal';
import type { Journal } from '../journal/service';
import type { LikeAcknowledgement } from '../like/adapter';
import type { MessagesInboxHandle } from '../messages-inbox';
import type { SchedulerController } from '../scheduler/controller';
import type { PooledMessage, SchedulerEvent } from '../scheduler/model';

interface SpikeEngineOptions {
  readonly chatGuid: ChatGuid;
  readonly database: Database;
  readonly delivery: DeliveryService;
  readonly inbox: MessagesInboxHandle;
  readonly like: LikeAcknowledgement;
  readonly now?: () => Date;
  readonly pollIntervalMs?: number;
  readonly renderStatus: () => Promise<string>;
  readonly runtime: CodexRuntime;
}

interface EngineContext {
  readonly closing: { value: boolean };
  readonly codexJournal: CodexJournal;
  readonly controllerReady: PromiseWithResolvers<SchedulerController>;
  readonly journal: Journal;
  readonly monitors: Map<string, Promise<void>>;
  readonly now: () => Date;
  readonly options: SpikeEngineOptions;
  readonly recoveryPending: { value: boolean };
  readonly schedulerJournal: SchedulerJournal;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
}

const inputText = (messages: readonly PooledMessage[]): string =>
  messages.map((message) => message.text).join('\n\n');

const statusError = (cause: unknown): SpikeRuntimeError =>
  new SpikeRuntimeError({ cause, message: compactError(cause), operation: 'status/render' });

const report = (context: EngineContext, error: unknown): void => {
  try {
    context.options.database.run(
      `INSERT INTO failures(correlation_id, operation, error_tag, message, details_json, created_at)
       VALUES (?, 'engine', ?, ?, NULL, ?)`,
      [
        randomUUID(),
        error instanceof Error ? error.name : 'UnknownError',
        compactError(error),
        context.now().toISOString(),
      ],
    );
  } catch {
    // The primary failure remains available through stderr/app-server logs.
  }
};

const controlReplyText = (
  context: EngineContext,
  kind: 'NewChat' | 'Status',
): Effect.Effect<string> => {
  if (kind === 'NewChat') {
    return Effect.succeed('New chat started.');
  }
  return Effect.gen(function* renderStatusReply() {
    const rendered = yield* Effect.result(
      Effect.tryPromise({ catch: statusError, try: context.options.renderStatus }),
    );
    if (Result.isSuccess(rendered)) {
      return rendered.success;
    }
    report(context, rendered.failure);
    return `Spike hit an error: ${compactError(rendered.failure)}`;
  });
};

const dispatch = async (context: EngineContext, event: SchedulerEvent): Promise<void> => {
  const controller = await context.controllerReady.promise;
  await Effect.runPromise(controller.dispatch(event));
};

export { controlReplyText, dispatch, inputText, report };
export type { EngineContext, SpikeEngineOptions };
