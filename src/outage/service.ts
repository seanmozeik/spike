import { Effect } from 'effect';

import type { OutageEpisodeId } from '../domain/ids';
import type { JournalTransactionError } from '../errors';
import type { CodexOutageKind, OutageJournal } from './journal';

interface OutageDelivery {
  readonly deliver: (
    episodeId: OutageEpisodeId,
    text: string,
    at: Date,
  ) => Effect.Effect<void, unknown>;
}

interface OutageService {
  readonly capacityUnavailable: (
    retryAt: Date,
    at: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly authenticationUnavailable: (at: Date) => Effect.Effect<void, JournalTransactionError>;
  readonly recovered: (at: Date) => Effect.Effect<number, JournalTransactionError>;
  readonly runtimeUnavailable: (at: Date) => Effect.Effect<void, JournalTransactionError>;
}

const AUTHENTICATION_TEXT =
  'Spike could not use any configured Codex account because each needed authentication. If this persists, run spike accounts list, add or repair an account, then restart Spike.';
const RUNTIME_TEXT =
  'Spike’s Codex app-server stopped unexpectedly; daemon restart is handled by launchd.';

const capacityText = (retryAt: Date): string =>
  `Every configured Codex account reached capacity. The earliest known retry boundary is ${retryAt.toISOString()}.`;

const makeOutageService = (journal: OutageJournal, delivery: OutageDelivery): OutageService => {
  const open = (
    kind: CodexOutageKind,
    text: string,
    at: Date,
  ): Effect.Effect<void, JournalTransactionError> =>
    Effect.gen(function* openOutage() {
      const episode = yield* journal.open(kind, text, at);
      yield* Effect.result(delivery.deliver(episode.id, text, at));
    });
  return {
    authenticationUnavailable: (at) => open('CodexAuthentication', AUTHENTICATION_TEXT, at),
    capacityUnavailable: (retryAt, at) => open('CodexCapacity', capacityText(retryAt), at),
    recovered: (at) => journal.resolve(at),
    runtimeUnavailable: (at) => journal.open('CodexRuntime', RUNTIME_TEXT, at).pipe(Effect.asVoid),
  };
};

export { makeOutageService };
export type { OutageDelivery, OutageService };
