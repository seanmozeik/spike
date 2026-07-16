import path from 'node:path';

import { Effect } from 'effect';

import { LikeNativeError } from './error';

interface LikeNativeOutcome {
  readonly kind: 'failed' | 'liked' | 'skipped';
  readonly reason?: string;
}

type LikeNativeRunner = (text: string) => Effect.Effect<LikeNativeOutcome, LikeNativeError>;

const parseOutcome = (stdout: string): LikeNativeOutcome => {
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new Error('Like helper returned an invalid response');
  }
  const { kind } = value;
  const reason = 'reason' in value && typeof value.reason === 'string' ? value.reason : undefined;
  if (kind !== 'failed' && kind !== 'liked' && kind !== 'skipped') {
    throw new Error('Like helper returned an unknown outcome');
  }
  return reason === undefined ? { kind } : { kind, reason };
};

const makeLikeNativeRunner =
  (
    handle: string,
    helperPath = process.env['SPIKE_LIKE_HELPER'] ?? path.join(import.meta.dir, 'spike-like'),
  ): LikeNativeRunner =>
  (text) =>
    Effect.tryPromise({
      catch: (cause) =>
        cause instanceof LikeNativeError
          ? cause
          : new LikeNativeError({ cause, message: 'Like helper failed' }),
      try: async () => {
        const child = Bun.spawn([helperPath, handle, text], { stderr: 'pipe', stdout: 'pipe' });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (exitCode !== 0) {
          throw new LikeNativeError({
            cause: new Error(`exit ${exitCode}`),
            message: stderr.trim() || `Like helper exited ${exitCode}`,
          });
        }
        return parseOutcome(stdout.trim());
      },
    });

export { makeLikeNativeRunner, parseOutcome };
export type { LikeNativeOutcome, LikeNativeRunner };
