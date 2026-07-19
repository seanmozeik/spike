import { randomUUID } from 'node:crypto';

import { Effect, Result } from 'effect';

import type { CodexServerRequest, JsonRpcId } from '../codex/server-request-registry';
import { compactError } from '../delivery/service';
import { approvalOutcome, approvalPrompt } from './format';
import { makeApprovalJournal, type ApprovalRecord, type CommandResolution } from './journal';
import { subscribeRuntime } from './manager-subscriptions';
import type {
  ApprovalContext,
  ApprovalManager as ApprovalManagerShape,
  ApprovalManagerOptions as ApprovalManagerOptionsShape,
} from './manager-types';
import { decodeApprovalRequest, safeDenial } from './model';

const MINUTES_PER_EXPIRY = 10;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const DEFAULT_EXPIRY_MS = MINUTES_PER_EXPIRY * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

const deliverControl = (
  context: ApprovalContext,
  sourceId: string,
  text: string,
): Effect.Effect<void, unknown> =>
  context.options.delivery.deliverControlMessage(sourceId, text, context.options.now());

const hasOutcome = (
  state: ApprovalRecord['state'],
): state is 'Approved' | 'Denied' | 'Expired' | 'Orphaned' =>
  state === 'Approved' || state === 'Denied' || state === 'Expired' || state === 'Orphaned';

const deliverOutcome = (
  context: ApprovalContext,
  record: ApprovalRecord,
): Effect.Effect<void, unknown> => {
  if (record.deliveredAt === null || record.state === 'Cancelled') {
    return Effect.void;
  }
  if (!hasOutcome(record.state)) {
    return Effect.void;
  }
  return deliverControl(
    context,
    `${record.id}:outcome:${record.state}`,
    approvalOutcome(record.state),
  ).pipe(Effect.ignoreCause);
};

const respond = Effect.fn('SpikeApproval.respond')(function* respond(
  context: ApprovalContext,
  record: ApprovalRecord,
) {
  if (record.response === null) {
    return true;
  }
  const response = yield* Effect.result(
    Effect.tryPromise(() =>
      context.options.runtime.respondToServerRequest(record.rpcRequestId, record.response),
    ),
  );
  if (Result.isSuccess(response)) {
    yield* context.journal.markResponded(record.id, context.options.now());
    return true;
  }
  yield* context.journal.markResponseFailed(
    record.id,
    compactError(response.failure),
    context.options.now(),
  );
  return false;
});

const respondAndDeliver = Effect.fn('SpikeApproval.respondAndDeliver')(function* respondAndDeliver(
  context: ApprovalContext,
  record: ApprovalRecord,
) {
  const responded = yield* respond(context, record);
  yield* deliverOutcome(context, responded ? record : { ...record, state: 'Orphaned' });
});

const deliverNext = Effect.fn('SpikeApproval.deliverNext')(function* deliverNext(
  context: ApprovalContext,
) {
  const next = yield* context.journal.nextUndelivered;
  if (next === null || context.isClosed()) {
    return;
  }
  const delivered = yield* Effect.result(deliverControl(context, next.id, approvalPrompt(next)));
  if (Result.isSuccess(delivered)) {
    yield* context.journal.markDelivered(next.id, context.options.now());
    return;
  }
  const expired = yield* context.journal.markDeliveryFailed(
    next.id,
    compactError(delivered.failure),
    context.options.now(),
  );
  if (expired !== null) {
    yield* respond(context, expired);
  }
});

const receive = Effect.fn('SpikeApproval.receive')(function* receive(
  context: ApprovalContext,
  envelope: CodexServerRequest,
) {
  if (context.isClosed()) {
    return;
  }
  const now = context.options.now();
  const decoded = decodeApprovalRequest(envelope, now, new Date(now.getTime() + context.expiryMs));
  if (!decoded.valid) {
    yield* Effect.promise(() =>
      context.options.runtime.respondToServerRequest(envelope.id, decoded.denial),
    );
    return;
  }
  yield* context.journal.enqueue(decoded.request, context.connectionId);
  yield* deliverNext(context);
});

const resolveControl = Effect.fn('SpikeApproval.resolveControl')(function* resolveControl(
  context: ApprovalContext,
  resolution: CommandResolution,
) {
  if (resolution.kind === 'Ignored') {
    return;
  }
  if (resolution.kind === 'NoPending') {
    yield* deliverControl(
      context,
      resolution.sourceId,
      'There is no permission request awaiting a decision.',
    );
    return;
  }
  yield* respondAndDeliver(context, resolution.record);
});

const orphanCurrent = Effect.fn('SpikeApproval.orphanConnection')(function* orphanCurrent(
  context: ApprovalContext,
) {
  if (context.isClosed()) {
    return;
  }
  for (const record of yield* context.journal.orphanConnection(
    context.connectionId,
    context.options.now(),
  )) {
    yield* deliverOutcome(context, record);
  }
});

const resolveUpstream = Effect.fn('SpikeApproval.resolveUpstream')(function* resolveUpstream(
  context: ApprovalContext,
  id: JsonRpcId,
) {
  const record = yield* context.journal.resolveUpstream(
    context.connectionId,
    id,
    context.options.now(),
  );
  if (record !== null && record.deliveredAt !== null) {
    yield* deliverControl(
      context,
      `${record.id}:upstream-resolved`,
      'Permission request was cancelled by Codex.',
    ).pipe(Effect.ignoreCause);
  }
  yield* deliverNext(context);
});

const pollUnlocked = Effect.fn('SpikeApproval.poll')(function* pollApprovals(
  context: ApprovalContext,
) {
  if (context.isClosed()) {
    return { nextExpiryAt: null };
  }
  while (context.pendingEvents.length > 0) {
    const [event] = context.pendingEvents;
    if (event === undefined) {
      break;
    }
    if (event.kind === 'Request') {
      yield* receive(context, event.request);
    } else if (event.kind === 'Resolved') {
      yield* resolveUpstream(context, event.id);
    } else {
      yield* orphanCurrent(context);
    }
    context.pendingEvents.shift();
  }
  for (const record of yield* context.journal.expireDue(context.options.now())) {
    yield* respondAndDeliver(context, record);
  }
  yield* deliverNext(context);
  return { nextExpiryAt: yield* context.journal.nextExpiryAt };
});

const pollCommandsUnlocked = Effect.fn('SpikeApproval.pollCommands')(function* pollApprovalCommands(
  context: ApprovalContext,
  after: Parameters<ApprovalManagerShape['pollCommands']>[0],
  through: Parameters<ApprovalManagerShape['pollCommands']>[1],
) {
  if (context.isClosed()) {
    return 0;
  }
  const commands = yield* context.journal.listCommands(after, through);
  for (const command of commands) {
    yield* resolveControl(
      context,
      yield* context.journal.resolveCommand(command, context.options.now()),
    );
  }
  yield* deliverNext(context);
  return commands.length;
});

const closeApprovalManager = (
  context: ApprovalContext,
  unsubscribe: readonly (() => void)[],
  markClosed: () => void,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* closeManager() {
    markClosed();
    for (const stop of unsubscribe) {
      stop();
    }
    while (context.pendingEvents.length > 0) {
      const [event] = context.pendingEvents;
      if (event === undefined) {
        break;
      }
      if (event.kind === 'Request') {
        const persisted = yield* context.journal.hasRequest(context.connectionId, event.request.id);
        if (!persisted) {
          yield* Effect.promise(() =>
            context.options.runtime.respondToServerRequest(
              event.request.id,
              safeDenial(event.request.method),
            ),
          );
        }
      }
      context.pendingEvents.shift();
    }
    for (const record of yield* context.journal.cancelConnection(
      context.connectionId,
      context.options.now(),
    )) {
      yield* respond(context, record);
    }
  });

const makeApprovalManager = Effect.fn('SpikeApproval.make')(function* makeApprovalManager(
  options: ApprovalManagerOptionsShape,
) {
  let closed = false;
  const context: ApprovalContext = {
    connectionId: randomUUID(),
    expiryMs: options.expiryMs ?? DEFAULT_EXPIRY_MS,
    isClosed: () => closed,
    journal: makeApprovalJournal(options.database),
    options,
    pendingEvents: [],
  };
  const unsubscribe = subscribeRuntime(context);
  for (const record of yield* context.journal.markOrphaned(context.connectionId, options.now())) {
    yield* deliverOutcome(context, record);
  }
  const close = closeApprovalManager(context, unsubscribe, () => {
    closed = true;
  });
  yield* deliverNext(context);
  return {
    close,
    connectionId: context.connectionId,
    journal: context.journal,
    poll: pollUnlocked(context),
    pollCommands: (after, through): ReturnType<ApprovalManagerShape['pollCommands']> =>
      pollCommandsUnlocked(context, after, through),
  } satisfies ApprovalManagerShape;
});

export { makeApprovalManager };
export type { ApprovalManager, ApprovalManagerOptions } from './manager-types';
