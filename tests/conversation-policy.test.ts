import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { expect } from 'vitest';

import { makeConversationPolicy } from '../src/conversation-policy';
import { openJournal, type JournalHandle } from '../src/database';
import {
  type MessagesTransport,
  withConversationAvailability,
} from '../src/delivery/messages-transport';
import type { SpikeRuntimeError } from '../src/errors';
import { makeConversationDiagnostic } from '../src/journal/conversation-diagnostic';

interface PolicyFixture {
  readonly handle: JournalHandle;
  readonly root: string;
}

const withPolicyFixture = <A, E, R>(
  use: (fixture: PolicyFixture) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SpikeRuntimeError, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'spike-conversation-policy-'))),
    (root) =>
      Effect.acquireUseRelease(
        openJournal(path.join(root, 'spike.db')),
        (handle) => use({ handle, root }),
        (handle) => Effect.sync(handle.close),
      ),
    (root) =>
      Effect.sync(() => {
        rmSync(root, { force: true, recursive: true });
      }),
  );

it.effect('checks only on schedule and deduplicates a content-free durable diagnostic', () =>
  withPolicyFixture(({ handle }) =>
    Effect.gen(function* scheduledValidation() {
      const startedAt = new Date('2026-07-18T12:00:00.000Z');
      let checks = 0;
      let valid = true;
      const policy = yield* makeConversationPolicy({
        diagnostic: makeConversationDiagnostic(handle.database),
        initialValidationAt: startedAt,
        probe: () =>
          Effect.suspend(() => {
            checks += 1;
            return valid ? Effect.void : Effect.fail(new Error('fixture boundary changed'));
          }),
        validationIntervalMs: 60_000,
      });

      const beforeDue = new Date(startedAt.getTime() + 59_999);
      const firstDue = new Date(startedAt.getTime() + 60_000);
      const afterDue = new Date(startedAt.getTime() + 60_001);
      expect(yield* policy.isAvailable).toBe(false);
      expect(yield* policy.revalidateIfDue(beforeDue)).toBe(false);
      expect(checks).toBe(0);
      expect(yield* policy.revalidate(startedAt, 'Startup')).toBe(true);
      expect(checks).toBe(1);
      expect(yield* policy.revalidateIfDue(beforeDue)).toBe(true);
      expect(checks).toBe(1);
      expect(yield* policy.revalidateIfDue(firstDue)).toBe(true);
      expect(checks).toBe(2);
      expect(yield* policy.revalidateIfDue(afterDue)).toBe(true);
      expect(checks).toBe(2);

      valid = false;
      const invalidAt = new Date(startedAt.getTime() + 120_000);
      expect(yield* policy.revalidateIfDue(invalidAt)).toBe(false);
      expect(yield* policy.revalidate(invalidAt, 'DatabaseChanged')).toBe(false);
      expect(
        handle.database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM failures WHERE operation = 'messages-conversation-validation'",
          )
          .get()?.count,
      ).toBe(1);
      const diagnostic = handle.database
        .query<{ details_json: null | string; message: string }, []>(
          "SELECT details_json, message FROM failures WHERE operation = 'messages-conversation-validation'",
        )
        .get();
      expect(diagnostic?.details_json).toBeNull();
      expect(diagnostic?.message).not.toContain('fixture boundary changed');

      valid = true;
      const recoveredAt = new Date(startedAt.getTime() + 121_000);
      expect(yield* policy.revalidate(recoveredAt, 'DatabaseChanged')).toBe(true);
      expect(
        handle.database
          .query<{ state: string }, []>(
            "SELECT state FROM outage_episodes WHERE kind = 'MessagesConversationBoundaryInvalid'",
          )
          .get()?.state,
      ).toBe('Resolved');
      policy.close();
    }),
  ),
);

it.effect('blocks concurrent delivery throughout a failing revalidation until exact recovery', () =>
  withPolicyFixture(({ handle }) =>
    Effect.gen(function* guardedDelivery() {
      const startedAt = new Date('2026-07-18T12:00:00.000Z');
      const invalidConversation = new Error('invalid conversation');
      const probeEntered = yield* Deferred.make<boolean>();
      const releaseProbe = yield* Deferred.make<boolean>();
      const failValidation = Effect.fail(invalidConversation);
      let deferredFailure = false;
      let valid = true;
      const policy = yield* makeConversationPolicy({
        diagnostic: makeConversationDiagnostic(handle.database),
        initialValidationAt: startedAt,
        probe: () => {
          if (deferredFailure) {
            return Deferred.succeed(probeEntered, true).pipe(
              Effect.andThen(Deferred.await(releaseProbe)),
              Effect.andThen(failValidation),
            );
          }
          return valid ? Effect.void : failValidation;
        },
      });
      expect(yield* policy.revalidate(startedAt, 'Startup')).toBe(true);

      const sent: string[] = [];
      const transport: MessagesTransport = {
        close: (): void => {
          // Test transport owns no resources.
        },
        findMatchingAfter: () => Effect.succeed(null),
        frontier: Effect.succeed(0),
        refresh: Effect.void,
        send: (text) =>
          Effect.sync(() => {
            sent.push(text);
          }),
      };
      const guarded = withConversationAvailability(transport, policy);
      deferredFailure = true;
      valid = false;
      const invalidatedAt = new Date(startedAt.getTime() + 1);
      const validation = yield* Effect.forkChild(
        policy.revalidate(invalidatedAt, 'DatabaseChanged'),
      );
      yield* Deferred.await(probeEntered);
      const delivery = yield* Effect.forkChild(guarded.send('held reply'));
      yield* Effect.yieldNow;
      expect(sent).toStrictEqual([]);

      yield* Deferred.succeed(releaseProbe, true);
      expect(yield* Fiber.join(validation)).toBe(false);
      yield* Effect.yieldNow;
      expect(sent).toStrictEqual([]);

      deferredFailure = false;
      valid = true;
      yield* policy.revalidate(new Date(startedAt.getTime() + 2), 'DatabaseChanged');
      yield* Fiber.join(delivery);
      expect(sent).toStrictEqual(['held reply']);
      policy.close();
    }),
  ),
);
