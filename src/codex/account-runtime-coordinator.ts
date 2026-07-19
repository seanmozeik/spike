import { Effect, Result } from 'effect';

import type { SpikeConfig } from '../app-config';
import { AccountId } from '../domain/ids';
import {
  CodexRuntimeError,
  SpikeRuntimeError,
  WaitingForAuthentication,
  WaitingForCapacity,
} from '../errors';
import type { CodexJournal } from '../journal/codex-journal';
import type { SpikePaths } from '../paths';
import { makeAccountResult } from './account-control';
import { discoverAccounts, selectAccount, type AccountRecord } from './account-pool';
import {
  coordinatorClosed,
  makeCoordinatorContext,
  serializeAccountRuntimeState,
  type AccountRuntimeCoordinator as AccountRuntimeCoordinatorContract,
  type AccountRuntimeCoordinatorOptions as AccountRuntimeCoordinatorOptionsContract,
  type AcquireDecision,
  type CoordinatorContext,
} from './account-runtime-state';
import { addStoredAccount, listStoredAccounts } from './account-store';
import { classifyCodexAvailability } from './availability';
import {
  openAccountCodexRuntime,
  openProviderCodexRuntime,
  readCustomProvider,
  type CodexRuntime,
} from './runtime';

class AccountRuntimeCoordinatorImpl implements AccountRuntimeCoordinatorContract {
  readonly snapshot: AccountRuntimeCoordinatorContract['snapshot'];
  readonly wake: AccountRuntimeCoordinatorContract['wake'];
  private readonly context: CoordinatorContext;
  private active: CodexRuntime | null = null;

  constructor(context: CoordinatorContext) {
    this.context = context;
    this.snapshot = context.state.current;
    this.wake = context.state.notify();
  }

  private recordSelection(
    account: AccountRecord,
    runtime: CodexRuntime,
  ): Effect.Effect<CodexRuntime, unknown> {
    return this.context.journal
      .recordAccountSelection(AccountId.make(account.id), this.context.now())
      .pipe(
        Effect.as(runtime),
        Effect.tapError(() => Effect.promise(runtime.close)),
      );
  }

  private recordOpenFailure(
    account: AccountRecord,
    failure: WaitingForAuthentication | WaitingForCapacity,
  ): Effect.Effect<void, unknown> {
    const capacityFailure = failure instanceof WaitingForCapacity;
    return this.context.journal.recordAccountObservation(
      AccountId.make(account.id),
      capacityFailure ? 'Capacity' : 'Authentication',
      null,
      capacityFailure ? failure.resetAt : null,
      this.context.now(),
    );
  }

  private openSelected(account: AccountRecord): Effect.Effect<AcquireDecision, unknown> {
    const { accountOptions, config, logMode, options, paths, state } = this.context;
    const recordSelection = (runtime: CodexRuntime): Effect.Effect<CodexRuntime, unknown> =>
      this.recordSelection(account, runtime);
    const recordOpenFailure = (
      failure: WaitingForAuthentication | WaitingForCapacity,
    ): Effect.Effect<void, unknown> => this.recordOpenFailure(account, failure);
    const activate = (runtime: CodexRuntime): Effect.Effect<void> =>
      Effect.sync(() => {
        this.active = runtime;
      }).pipe(Effect.andThen(state.set({ accountId: account.id, kind: 'Active' })));
    return Effect.gen(function* openSelected() {
      const opened = yield* Effect.result(
        options.openAccount?.(account) ??
          openAccountCodexRuntime(paths, config, accountOptions, account, logMode),
      );
      if (Result.isSuccess(opened)) {
        const runtime = yield* recordSelection(opened.success);
        yield* activate(runtime);
        return { kind: 'Acquired' as const, runtime };
      }
      const classified =
        opened.failure instanceof CodexRuntimeError
          ? classifyCodexAvailability(opened.failure)
          : opened.failure;
      if (
        classified instanceof WaitingForAuthentication ||
        classified instanceof WaitingForCapacity
      ) {
        yield* recordOpenFailure(classified);
        return { kind: 'Retry' as const };
      }
      return yield* new SpikeRuntimeError({
        cause: opened.failure,
        message: `failed to open Codex account ${account.id}`,
        operation: 'account-runtime/open',
      });
    }).pipe(Effect.withSpan('SpikeAccounts.openSelected'));
  }

  private openProvider(provider: string): Effect.Effect<AcquireDecision, unknown> {
    const { config, logMode, options, paths, state } = this.context;
    return (
      options.openProvider?.(provider) ?? openProviderCodexRuntime(paths, config, provider, logMode)
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SpikeRuntimeError({
            cause,
            message: 'failed to open the configured Codex provider',
            operation: 'account-runtime/provider-open',
          }),
      ),
      Effect.tap((runtime) => {
        this.active = runtime;
        return state.set({ accountId: runtime.accountId, kind: 'Active' });
      }),
      Effect.map((runtime) => ({ kind: 'Acquired' as const, runtime })),
    );
  }

  private selectUnlocked(): Effect.Effect<AcquireDecision, unknown> {
    const { accountOptions, config, journal, now, options, state } = this.context;
    const active = (): CodexRuntime | null => this.active;
    const openProvider = (provider: string): Effect.Effect<AcquireDecision, unknown> =>
      this.openProvider(provider);
    const openSelected = (account: AccountRecord): Effect.Effect<AcquireDecision, unknown> =>
      this.openSelected(account);
    return Effect.gen(function* selectAccountRuntime() {
      const current = yield* state.current;
      if (current.kind === 'Closed') {
        return yield* coordinatorClosed();
      }
      const activeRuntime = active();
      if (activeRuntime !== null) {
        return { kind: 'Acquired' as const, runtime: activeRuntime };
      }
      yield* state.set({ kind: 'Selecting' });
      const provider = yield* (options.readProvider ?? readCustomProvider(config)).pipe(
        Effect.mapError(
          (cause) =>
            new SpikeRuntimeError({
              cause,
              message: 'failed to inspect the configured Codex provider',
              operation: 'account-runtime/provider',
            }),
        ),
      );
      if (provider !== null) {
        return yield* openProvider(provider);
      }
      const accounts = yield* discoverAccounts(
        accountOptions,
        yield* journal.loadAccountObservations,
      );
      const selected = selectAccount(accounts, now());
      if (selected.kind === 'Selected') {
        return yield* openSelected(selected.account);
      }
      if (selected.kind === 'WaitingForCapacity' && selected.error.resetAt !== null) {
        yield* state.set({ kind: 'WaitingForCapacity', retryAt: selected.error.resetAt });
        return {
          kind: 'Wait' as const,
          retryAt: selected.error.resetAt,
          wakeVersion: state.version,
        };
      }
      yield* state.set({ kind: 'WaitingForAuthentication' });
      return { kind: 'Wait' as const, retryAt: null, wakeVersion: state.version };
    });
  }

  private selectOnce(): Effect.Effect<AcquireDecision, unknown> {
    return this.context.semaphore.withPermit(this.selectUnlocked());
  }

  private acquireRuntime(): AccountRuntimeCoordinatorContract['acquire'] {
    return this.selectOnce().pipe(
      Effect.flatMap((decision): AccountRuntimeCoordinatorContract['acquire'] => {
        if (decision.kind === 'Acquired') {
          return Effect.succeed(decision.runtime);
        }
        const next = Effect.suspend((): AccountRuntimeCoordinatorContract['acquire'] =>
          this.acquireRuntime(),
        );
        return decision.kind === 'Retry'
          ? next
          : this.context.state
              .wait(decision.retryAt, decision.wakeVersion, this.context.now())
              .pipe(Effect.andThen(next));
      }),
    );
  }

  get acquire(): AccountRuntimeCoordinatorContract['acquire'] {
    return Effect.suspend((): AccountRuntimeCoordinatorContract['acquire'] =>
      this.acquireRuntime(),
    );
  }

  add(accountId: string, sourcePath: string): ReturnType<AccountRuntimeCoordinatorContract['add']> {
    return addStoredAccount(
      { accountsDirectory: this.context.paths.accounts },
      accountId,
      sourcePath,
    ).pipe(
      Effect.tap(() => this.context.state.notify()),
      Effect.map((account) => ({ account: { id: account.id }, ok: true })),
    );
  }

  get close(): Effect.Effect<void> {
    const closed = this.context.state.set({ kind: 'Closed' });
    const notified = closed.pipe(Effect.andThen(this.context.state.notify()));
    return this.context.semaphore.withPermit(notified);
  }

  get list(): AccountRuntimeCoordinatorContract['list'] {
    const { journal, paths, state } = this.context;
    return Effect.gen(function* listAccounts() {
      const [stored, observations, current] = yield* Effect.all(
        [
          listStoredAccounts({ accountsDirectory: paths.accounts }),
          journal.loadAccountObservations,
          state.current,
        ],
        { concurrency: 'unbounded' },
      );
      return makeAccountResult(
        stored,
        observations,
        current.kind === 'Active' ? current.accountId : null,
        serializeAccountRuntimeState(current),
      );
    });
  }

  release(runtime: CodexRuntime): Effect.Effect<void> {
    const { state } = this.context;
    const isActive = (): boolean => this.active === runtime;
    const clearActive = (): void => {
      this.active = null;
    };
    return this.context.semaphore.withPermit(
      Effect.gen(function* releaseRuntime() {
        if (!isActive()) {
          return;
        }
        yield* Effect.sync(clearActive);
        yield* Effect.promise(runtime.close);
        const current = yield* state.current;
        if (current.kind !== 'Closed') {
          yield* state.set({ kind: 'Idle' });
        }
      }),
    );
  }
}

const makeAccountRuntimeCoordinator = Effect.fn('SpikeAccounts.makeCoordinator')(
  function* makeAccountRuntimeCoordinator(
    paths: SpikePaths,
    config: SpikeConfig,
    journal: CodexJournal,
    options: AccountRuntimeCoordinatorOptionsContract = {},
  ) {
    const context = yield* makeCoordinatorContext(paths, config, journal, options);
    return new AccountRuntimeCoordinatorImpl(context);
  },
);

export { makeAccountRuntimeCoordinator };
export type {
  AccountRuntimeCoordinator,
  AccountRuntimeCoordinatorOptions,
  AccountRuntimeState,
} from './account-runtime-state';
