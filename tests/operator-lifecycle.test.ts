import { it } from '@effect/vitest';
import { Effect, Fiber, Result } from 'effect';
import { TestClock } from 'effect/testing';
import { expect } from 'vitest';

import type { ProcessResult } from '../src/launchd';
import type { LaunchctlArguments, OperatorCommandPort } from '../src/operator/commands';
import {
  makeServiceLifecycle,
  serviceIsMissing,
  type ServiceLifecycle,
} from '../src/operator/lifecycle';

const ok = (stdout = ''): ProcessResult => ({
  exitCode: 0,
  signalCode: null,
  stderr: '',
  stdout,
  timedOut: false,
});
const missing = (stderr = 'Could not find service'): ProcessResult => ({
  exitCode: 3,
  signalCode: null,
  stderr,
  stdout: '',
  timedOut: false,
});

const tracedCommands = (
  respond: (args: LaunchctlArguments, call: number) => ProcessResult,
): {
  readonly calls: LaunchctlArguments[];
  readonly commands: Pick<OperatorCommandPort, 'launchctl'>;
} => {
  const calls: LaunchctlArguments[] = [];
  return {
    calls,
    commands: {
      launchctl: (args) =>
        Effect.sync(() => {
          calls.push(args);
          return respond(args, calls.length);
        }),
    },
  };
};

const lifecycle = (
  commands: Pick<OperatorCommandPort, 'launchctl'>,
  prepare: Effect.Effect<void> = Effect.void,
): ServiceLifecycle =>
  makeServiceLifecycle({
    commands,
    domain: 'gui/501',
    label: 'com.mozeik.spike',
    launchAgent: '/tmp/spike.plist',
    prepare,
    socket: '/tmp/spike.sock',
    unloadPollInterval: '10 millis',
    unloadRetries: 2,
  });

it('classifies only launchctl missing-service diagnostics as absent', () => {
  expect(serviceIsMissing('Could not find service "com.mozeik.spike"')).toBe(true);
  expect(serviceIsMissing('Boot-out failed: 3: No such process')).toBe(true);
  expect(serviceIsMissing('Operation not permitted')).toBe(false);
  expect(serviceIsMissing('malformed output')).toBe(false);
});

it.effect('starts through the exact launchctl transition after scheduled unload polling', () =>
  Effect.gen(function* successfulStart() {
    const trace = tracedCommands((_args, call) => {
      if (call === 2) {
        return ok('still loaded');
      }
      return call === 3 ? missing() : ok();
    });
    const started = yield* lifecycle(trace.commands).start.pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust('10 millis');

    expect(yield* Fiber.join(started)).toEqual({
      label: 'com.mozeik.spike',
      ok: true,
      socket: '/tmp/spike.sock',
      status: 'started',
    });
    expect(trace.calls).toStrictEqual([
      ['bootout', 'gui/501/com.mozeik.spike'],
      ['print', 'gui/501/com.mozeik.spike'],
      ['print', 'gui/501/com.mozeik.spike'],
      ['bootstrap', 'gui/501', '/tmp/spike.plist'],
      ['kickstart', '-k', 'gui/501/com.mozeik.spike'],
    ]);
  }),
);

it.effect('stops idempotently when launchctl reports a missing service', () =>
  Effect.gen(function* missingStop() {
    const trace = tracedCommands(() => missing('Boot-out failed: 3: No such process'));
    expect(yield* lifecycle(trace.commands).stop).toEqual({
      label: 'com.mozeik.spike',
      ok: true,
      status: 'stopped',
    });
    expect(trace.calls).toStrictEqual([['bootout', 'gui/501/com.mozeik.spike']]);
  }),
);

it.effect('keeps permission denials typed with stderr and argv', () =>
  Effect.gen(function* permissionDenied() {
    const trace = tracedCommands(() => ({
      exitCode: 1,
      signalCode: null,
      stderr: 'Boot-out failed: 1: Operation not permitted',
      stdout: '',
      timedOut: false,
    }));
    const stopped = yield* Effect.result(lifecycle(trace.commands).stop);

    expect(Result.isFailure(stopped)).toBe(true);
    if (Result.isFailure(stopped)) {
      expect(stopped.failure).toMatchObject({
        message: 'launchctl bootout failed: Boot-out failed: 1: Operation not permitted',
        operation: 'launchctl/bootout',
      });
      expect(stopped.failure.cause).toEqual({
        argv: ['launchctl', 'bootout', 'gui/501/com.mozeik.spike'],
        exitCode: 1,
        signalCode: null,
        stderr: 'Boot-out failed: 1: Operation not permitted',
        stdout: '',
        timedOut: false,
      });
    }
  }),
);

it.effect('classifies a bounded launchctl process timeout explicitly', () =>
  Effect.gen(function* commandTimeout() {
    const trace = tracedCommands(() => ({
      exitCode: 1,
      signalCode: 'SIGKILL',
      stderr: '',
      stdout: '',
      timedOut: true,
    }));
    const stopped = yield* Effect.result(lifecycle(trace.commands).stop);

    expect(Result.isFailure(stopped)).toBe(true);
    if (Result.isFailure(stopped)) {
      expect(stopped.failure).toMatchObject({
        message: 'launchctl bootout failed: command timed out',
        operation: 'launchctl/bootout',
      });
      expect(stopped.failure.cause).toMatchObject({ signalCode: 'SIGKILL', timedOut: true });
    }
  }),
);

it.effect('rejects malformed print output instead of treating it as an unloaded service', () =>
  Effect.gen(function* malformedPrint() {
    const trace = tracedCommands((_args, call) =>
      call === 1
        ? ok()
        : {
            exitCode: 64,
            signalCode: null,
            stderr: 'unexpected launchctl response',
            stdout: '{not-a-service',
            timedOut: false,
          },
    );
    const stopped = yield* Effect.result(lifecycle(trace.commands).stop);

    expect(Result.isFailure(stopped)).toBe(true);
    if (Result.isFailure(stopped)) {
      expect(stopped.failure).toMatchObject({
        message: 'launchctl print failed: unexpected launchctl response',
        operation: 'launchctl/print',
      });
      expect(stopped.failure.cause).toMatchObject({
        argv: ['launchctl', 'print', 'gui/501/com.mozeik.spike'],
        exitCode: 64,
        stdout: '{not-a-service',
      });
    }
    expect(trace.calls).toHaveLength(2);
  }),
);

it.effect('fails after the configured unload schedule without wall-clock sleep', () =>
  Effect.gen(function* unloadTimeout() {
    const trace = tracedCommands(() => ok('still loaded'));
    const stopped = yield* lifecycle(trace.commands).stop.pipe(
      Effect.result,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust('20 millis');
    const result = yield* Fiber.join(stopped);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        message: 'launchctl bootout failed: service remained loaded after bootout',
        operation: 'launchctl/bootout',
      });
    }
    expect(trace.calls).toStrictEqual([
      ['bootout', 'gui/501/com.mozeik.spike'],
      ['print', 'gui/501/com.mozeik.spike'],
      ['print', 'gui/501/com.mozeik.spike'],
      ['print', 'gui/501/com.mozeik.spike'],
    ]);
  }),
);

it.effect('restarts through one unload and one prepared activation', () =>
  Effect.gen(function* successfulRestart() {
    let prepares = 0;
    const trace = tracedCommands((_args, call) => (call === 1 ? missing() : ok()));
    const restarted = yield* lifecycle(
      trace.commands,
      Effect.sync(() => {
        prepares += 1;
      }),
    ).restart;

    expect(restarted.status).toBe('started');
    expect(prepares).toBe(1);
    expect(trace.calls).toStrictEqual([
      ['bootout', 'gui/501/com.mozeik.spike'],
      ['bootstrap', 'gui/501', '/tmp/spike.plist'],
      ['kickstart', '-k', 'gui/501/com.mozeik.spike'],
    ]);
  }),
);

it.effect('preserves a failed activation command as an actionable typed cause', () =>
  Effect.gen(function* bootstrapFailure() {
    const trace = tracedCommands((args) =>
      args[0] === 'bootstrap'
        ? {
            exitCode: 5,
            signalCode: null,
            stderr: 'Input/output error',
            stdout: 'ignored',
            timedOut: false,
          }
        : missing(),
    );
    const started = yield* Effect.result(lifecycle(trace.commands).start);

    expect(Result.isFailure(started)).toBe(true);
    if (Result.isFailure(started)) {
      expect(started.failure).toMatchObject({
        message: 'launchctl bootstrap failed: Input/output error',
        operation: 'launchctl/bootstrap',
      });
      expect(started.failure.cause).toMatchObject({
        argv: ['launchctl', 'bootstrap', 'gui/501', '/tmp/spike.plist'],
        exitCode: 5,
        stderr: 'Input/output error',
      });
    }
  }),
);

it.effect('interrupting an operator command runs its process-boundary finalizer', () =>
  Effect.gen(function* commandCleanup() {
    let released = 0;
    const commands: Pick<OperatorCommandPort, 'launchctl'> = {
      launchctl: () =>
        Effect.acquireUseRelease(
          Effect.void,
          () => Effect.never,
          () =>
            Effect.sync(() => {
              released += 1;
            }),
        ),
    };
    const running = yield* lifecycle(commands).stop.pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(running);

    expect(released).toBe(1);
  }),
);
