import { Effect } from 'effect';

import { JournalTransactionError } from '../errors';

const wrap = <A>(transaction: string, run: () => A): Effect.Effect<A, JournalTransactionError> =>
  Effect.try({
    catch: (cause) =>
      new JournalTransactionError({
        cause,
        message: `approval journal transaction failed: ${transaction}`,
        transaction,
      }),
    try: run,
  });

export { wrap };
