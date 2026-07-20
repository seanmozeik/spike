import path from 'node:path';

import { Duration, Effect, Ref, Semaphore } from 'effect';

import type { SpikeConfig } from '../app-config';
import {
  SpikeRuntimeError,
  type CodexRuntimeError,
  type WaitingForAuthentication,
  type WaitingForCapacity,
} from '../errors';
import type { CodexJournal } from '../journal/codex-journal';
import type { SpikePaths } from '../paths';
import type { AccountAddResult, AccountResult, AccountRuntimeStateResult } from './account-control';
import type { AccountPoolOptions, AccountRecord } from './account-pool';
import type { CodexRuntime } from './runtime';
import type { CodexLogMode } from './stderr-log';

type AccountRuntimeState =
  | { readonly kind: 'Idle' }
  | { readonly kind: 'Selecting' }
  | { readonly accountId: string; readonly kind: 'Active' }
  | { readonly kind: 'WaitingForAuthentication' }
  | { readonly kind: 'WaitingForCapacity'; readonly retryAt: Date }
  | { readonly kind: 'Closed' };

interface AccountRuntimeCoordinatorOptions {
  readonly logMode?: CodexLogMode;
  readonly now?: () => Date;
  readonly onAvailable?: () => Effect.Effect<void, unknown>;
  readonly onWaitingForAuthentication?: () => Effect.Effect<void, unknown>;
  readonly onWaitingForCapacity?: (retryAt: Date) => Effect.Effect<void, unknown>;
  readonly openAccount?: (
    account: AccountRecord,
  ) => Effect.Effect<
    CodexRuntime,
    CodexRuntimeError | WaitingForAuthentication | WaitingForCapacity
  >;
  readonly openProvider?: (provider: string) => Effect.Effect<CodexRuntime, CodexRuntimeError>;
  readonly readProvider?: Effect.Effect<null | string, CodexRuntimeError>;
}

interface AccountRuntimeCoordinator {
  readonly acquire: Effect.Effect<CodexRuntime, unknown>;
  readonly add: (accountId: string, sourcePath: string) => Effect.Effect<AccountAddResult, unknown>;
  readonly close: Effect.Effect<void>;
  readonly list: Effect.Effect<AccountResult, unknown>;
  readonly release: (runtime: CodexRuntime) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<AccountRuntimeState>;
  readonly wake: Effect.Effect<void>;
}

type AcquireDecision =
  | { readonly kind: 'Acquired'; readonly runtime: CodexRuntime }
  | { readonly kind: 'Retry' }
  | { readonly kind: 'Wait'; readonly retryAt: Date | null; readonly wakeVersion: number };

interface CoordinatorContext {
  readonly accountOptions: AccountPoolOptions;
  readonly config: SpikeConfig;
  readonly journal: CodexJournal;
  readonly logMode: CodexLogMode;
  readonly now: () => Date;
  readonly options: AccountRuntimeCoordinatorOptions;
  readonly paths: SpikePaths;
  readonly semaphore: Semaphore.Semaphore;
  readonly state: AccountRuntimeStateController;
}

const coordinatorClosed = (): SpikeRuntimeError =>
  new SpikeRuntimeError({
    cause: new Error('account runtime coordinator is closed'),
    message: 'Codex account runtime coordinator is closed',
    operation: 'account-runtime/acquire',
  });

class AccountRuntimeStateController {
  static readonly make = Ref.make<AccountRuntimeState>({ kind: 'Idle' }).pipe(
    Effect.map((reference) => new AccountRuntimeStateController(reference)),
  );

  private readonly reference: Ref.Ref<AccountRuntimeState>;
  private waiter = Promise.withResolvers<null>();
  private wakeVersion = 0;

  constructor(reference: Ref.Ref<AccountRuntimeState>) {
    this.reference = reference;
  }

  get current(): Effect.Effect<AccountRuntimeState> {
    return Ref.get(this.reference);
  }

  get version(): number {
    return this.wakeVersion;
  }

  set(state: AccountRuntimeState): Effect.Effect<void> {
    return Ref.set(this.reference, state);
  }

  notify(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.wakeVersion += 1;
      this.waiter.resolve(null);
      this.waiter = Promise.withResolvers<null>();
    });
  }

  wait(retryAt: Date | null, observedVersion: number, now: Date): Effect.Effect<void> {
    const waiter = this.waiter.promise;
    if (this.wakeVersion !== observedVersion) {
      return Effect.void;
    }
    const notified = Effect.promise(() => waiter).pipe(Effect.asVoid);
    if (retryAt === null) {
      return notified;
    }
    const remaining = Math.max(0, retryAt.getTime() - now.getTime());
    return Effect.race(notified, Effect.sleep(Duration.millis(remaining)));
  }
}

const serializeAccountRuntimeState = (state: AccountRuntimeState): AccountRuntimeStateResult => {
  if (state.kind === 'WaitingForCapacity') {
    return { kind: state.kind, retryAt: state.retryAt.toISOString() };
  }
  if (state.kind === 'Active') {
    return { accountId: state.accountId, kind: state.kind };
  }
  return { kind: state.kind };
};

const makeCoordinatorContext = Effect.fn('SpikeAccounts.makeCoordinatorContext')(
  function* makeCoordinatorContext(
    paths: SpikePaths,
    config: SpikeConfig,
    journal: CodexJournal,
    options: AccountRuntimeCoordinatorOptions,
  ) {
    return {
      accountOptions: {
        accountsDirectory: paths.accounts,
        codexHome: config.codexHome,
        seedAuthPath: path.join(config.codexHome, 'auth.json'),
      },
      config,
      journal,
      logMode: options.logMode ?? 'quiet',
      now: options.now ?? ((): Date => new Date()),
      options,
      paths,
      semaphore: yield* Semaphore.make(1),
      state: yield* AccountRuntimeStateController.make,
    } satisfies CoordinatorContext;
  },
);

export {
  AccountRuntimeStateController,
  coordinatorClosed,
  makeCoordinatorContext,
  serializeAccountRuntimeState,
};
export type {
  AccountRuntimeCoordinator,
  AccountRuntimeCoordinatorOptions,
  AccountRuntimeState,
  AcquireDecision,
  CoordinatorContext,
};
