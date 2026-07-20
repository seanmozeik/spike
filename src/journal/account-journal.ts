import type { Database } from 'bun:sqlite';

import type { Effect } from 'effect';

import type { AccountAvailabilityMode, AccountObservation } from '../codex/account-pool';
import type { AccountId } from '../domain/ids';
import { tryJournalTransaction, type JournalTransactionError } from '../errors';

interface AccountObservationRow {
  readonly account_id: string;
  readonly mode: AccountAvailabilityMode;
  readonly observed_at: string;
  readonly reset_at: string | null;
  readonly selected_at: string | null;
  readonly usage_json: string | null;
}

interface AccountJournal {
  readonly loadAccountObservations: Effect.Effect<
    readonly AccountObservation[],
    JournalTransactionError
  >;
  readonly recordAccountObservation: (
    accountId: AccountId,
    mode: AccountAvailabilityMode,
    usage: unknown,
    resetAt: Date | null,
    observedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
  readonly recordAccountSelection: (
    accountId: AccountId,
    selectedAt: Date,
  ) => Effect.Effect<void, JournalTransactionError>;
}

const storedDate = (value: string, field: string): Date => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`stored account observation has invalid ${field}`);
  }
  return parsed;
};

const parseObservation = (row: AccountObservationRow): AccountObservation => ({
  accountId: row.account_id,
  lastSelectedAt:
    row.selected_at === null ? null : storedDate(row.selected_at, 'last selected time'),
  mode: row.mode,
  observedAt: storedDate(row.observed_at, 'observation time'),
  resetAt: row.reset_at === null ? null : storedDate(row.reset_at, 'reset time'),
});

const serializeUsage = (usage: unknown): string | null =>
  usage === undefined || usage === null ? null : JSON.stringify(usage);

const loadObservations = (database: Database): AccountJournal['loadAccountObservations'] =>
  tryJournalTransaction('loadAccountObservations', 'loadAccountObservations failed', () =>
    database
      .query<AccountObservationRow, []>(
        `SELECT observation.account_id, observation.observed_at, observation.mode,
                  observation.usage_json, observation.reset_at, observation.selected_at
           FROM account_observations observation
           WHERE observation.id IN (
             SELECT MAX(latest.id) FROM account_observations latest GROUP BY latest.account_id
           )
           ORDER BY observation.account_id`,
      )
      .all()
      .map((row) => parseObservation(row)),
  );

const recordObservation =
  (database: Database): AccountJournal['recordAccountObservation'] =>
  (accountId, mode, usage, resetAt, observedAt) =>
    tryJournalTransaction('recordAccountObservation', 'recordAccountObservation failed', () => {
      database.run(
        `INSERT INTO account_observations(
             account_id, observed_at, usable, mode, usage_json, reset_at, selected_at
           ) VALUES (?, ?, ?, ?, ?, ?, (
             SELECT selected_at FROM account_observations
             WHERE account_id = ? ORDER BY id DESC LIMIT 1
           ))`,
        [
          accountId,
          observedAt.toISOString(),
          mode === 'Available' ? 1 : 0,
          mode,
          serializeUsage(usage),
          resetAt?.toISOString() ?? null,
          accountId,
        ],
      );
    });

const recordSelection = (database: Database): AccountJournal['recordAccountSelection'] => {
  const transaction = database.transaction((accountId: AccountId, selectedAt: string): void => {
    const latest = database
      .query<AccountObservationRow, [string]>(
        `SELECT account_id, observed_at, mode, usage_json, reset_at, selected_at
         FROM account_observations WHERE account_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(accountId);
    database.run(
      `INSERT INTO account_observations(
         account_id, observed_at, usable, mode, usage_json, reset_at, selected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      latest === null
        ? [accountId, selectedAt, 1, 'Available', null, null, selectedAt]
        : [
            accountId,
            latest.observed_at,
            latest.mode === 'Available' ? 1 : 0,
            latest.mode,
            latest.usage_json,
            latest.reset_at,
            selectedAt,
          ],
    );
  });
  return (accountId, selectedAt) =>
    tryJournalTransaction('recordAccountSelection', 'recordAccountSelection failed', () => {
      transaction(accountId, selectedAt.toISOString());
    });
};

const makeAccountJournal = (database: Database): AccountJournal => ({
  loadAccountObservations: loadObservations(database),
  recordAccountObservation: recordObservation(database),
  recordAccountSelection: recordSelection(database),
});

export { makeAccountJournal };
export type { AccountJournal };
