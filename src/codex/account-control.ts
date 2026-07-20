import { Schema } from 'effect';

import type { AccountObservation } from './account-pool';
import type { StoredAccount } from './account-store';

const AccountAvailabilityMode = Schema.Literals(['Authentication', 'Available', 'Capacity']);

const InactiveAccountRuntimeState = Schema.Struct({
  kind: Schema.Literals(['Idle', 'Selecting', 'WaitingForAuthentication', 'Closed']),
});
const ActiveAccountRuntimeState = Schema.Struct({
  accountId: Schema.String,
  kind: Schema.Literal('Active'),
});
const WaitingAccountRuntimeState = Schema.Struct({
  kind: Schema.Literal('WaitingForCapacity'),
  retryAt: Schema.String,
});
const AccountRuntimeStateResult = Schema.Union([
  InactiveAccountRuntimeState,
  ActiveAccountRuntimeState,
  WaitingAccountRuntimeState,
]);
type AccountRuntimeStateResult = typeof AccountRuntimeStateResult.Type;

const AccountEntryResult = Schema.Struct({ eligible: Schema.Boolean, id: Schema.String });
const AccountObservationResult = Schema.Struct({
  accountId: Schema.String,
  lastSelectedAt: Schema.NullOr(Schema.String),
  mode: AccountAvailabilityMode,
  observedAt: Schema.String,
  resetAt: Schema.NullOr(Schema.String),
});
const AccountResult = Schema.Struct({
  accounts: Schema.Array(AccountEntryResult),
  active: Schema.NullOr(Schema.String),
  observations: Schema.Array(AccountObservationResult),
  ok: Schema.Literal(true),
  state: Schema.NullOr(AccountRuntimeStateResult),
});
type AccountResult = typeof AccountResult.Type;

const AccountAddResult = Schema.Struct({
  account: Schema.Struct({ id: Schema.String }),
  ok: Schema.Literal(true),
});
type AccountAddResult = typeof AccountAddResult.Type;

const isAccountResult = Schema.is(AccountResult);
const isAccountAddResult = Schema.is(AccountAddResult);

const makeAccountResult = (
  stored: readonly StoredAccount[],
  observations: readonly AccountObservation[],
  active: string | null,
  state: AccountRuntimeStateResult,
): AccountResult => {
  const storedIds = new Set(stored.map((account) => account.id));
  return {
    accounts: stored.map((account) => ({ eligible: true, id: account.id })),
    active,
    observations: observations
      .filter((observation) => storedIds.has(observation.accountId))
      .map((observation) => ({
        accountId: observation.accountId,
        lastSelectedAt: observation.lastSelectedAt?.toISOString() ?? null,
        mode: observation.mode,
        observedAt: observation.observedAt.toISOString(),
        resetAt: observation.resetAt?.toISOString() ?? null,
      })),
    ok: true,
    state,
  };
};

export { AccountAddResult, AccountResult, isAccountAddResult, isAccountResult, makeAccountResult };
export type { AccountRuntimeStateResult };
