import { Duration, Effect, Schedule, Schema } from 'effect';

import { SpikeRuntimeError } from '../errors';
import type { ProcessResult } from '../launchd';
import type { LaunchctlArguments, OperatorCommandPort } from './commands';

class ServiceStillLoaded extends Schema.TaggedErrorClass<ServiceStillLoaded>()(
  'ServiceStillLoaded',
  { target: Schema.String },
) {}

interface ServiceLifecycleOptions {
  readonly commands: Pick<OperatorCommandPort, 'launchctl'>;
  readonly domain: string;
  readonly label: string;
  readonly launchAgent: string;
  readonly prepare: Effect.Effect<void, SpikeRuntimeError>;
  readonly socket: string;
  readonly unloadPollInterval?: Duration.Input;
  readonly unloadRetries?: number;
}

interface ServiceLifecycleResult {
  readonly label: string;
  readonly ok: true;
  readonly socket?: string;
  readonly status: 'started' | 'stopped';
}

interface ServiceInspection {
  readonly loaded: boolean;
  readonly result: ProcessResult;
}

interface ServiceLifecycle {
  readonly restart: Effect.Effect<ServiceLifecycleResult, SpikeRuntimeError>;
  readonly start: Effect.Effect<ServiceLifecycleResult, SpikeRuntimeError>;
  readonly stop: Effect.Effect<ServiceLifecycleResult, SpikeRuntimeError>;
}

const DEFAULT_UNLOAD_POLL_INTERVAL = Duration.millis(200);
const DEFAULT_UNLOAD_RETRIES = 100;

const serviceIsMissing = (stderr: string): boolean =>
  stderr.includes('Could not find service') || stderr.includes('No such process');

const resultDetail = (result: ProcessResult): string =>
  result.timedOut
    ? 'command timed out'
    : result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;

const launchctlError = (
  args: LaunchctlArguments,
  result: ProcessResult,
  message = resultDetail(result),
): SpikeRuntimeError =>
  new SpikeRuntimeError({
    cause: { argv: ['launchctl', ...args], ...result },
    message: `launchctl ${args[0]} failed: ${message}`,
    operation: `launchctl/${args[0]}`,
  });

const classifyServiceInspection = (
  target: string,
  result: ProcessResult,
): Effect.Effect<ServiceInspection, SpikeRuntimeError> => {
  if (result.timedOut) {
    return Effect.fail(launchctlError(['print', target], result));
  }
  if (result.exitCode === 0) {
    return Effect.succeed({ loaded: true, result });
  }
  return serviceIsMissing(result.stderr)
    ? Effect.succeed({ loaded: false, result })
    : Effect.fail(launchctlError(['print', target], result));
};

const requireSuccess = (
  commands: ServiceLifecycleOptions['commands'],
  args: LaunchctlArguments,
): Effect.Effect<ProcessResult, SpikeRuntimeError> =>
  commands
    .launchctl(args)
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0 && !result.timedOut
          ? Effect.succeed(result)
          : Effect.fail(launchctlError(args, result)),
      ),
    );

const waitUntilUnloaded = Effect.fn('SpikeLifecycle.waitUntilUnloaded')(function* waitUntilUnloaded(
  options: ServiceLifecycleOptions,
) {
  const target = `${options.domain}/${options.label}`;
  const args = ['print', target] as const;
  const inspect: Effect.Effect<void, ServiceStillLoaded | SpikeRuntimeError> = options.commands
    .launchctl(args)
    .pipe(
      Effect.flatMap((result) => classifyServiceInspection(target, result)),
      Effect.flatMap((inspection) =>
        inspection.loaded ? Effect.fail(new ServiceStillLoaded({ target })) : Effect.void,
      ),
    );
  const schedule = Schedule.max([
    Schedule.spaced(options.unloadPollInterval ?? DEFAULT_UNLOAD_POLL_INTERVAL),
    Schedule.recurs(options.unloadRetries ?? DEFAULT_UNLOAD_RETRIES),
  ]);
  yield* inspect.pipe(
    Effect.retry({ schedule, while: (error) => error instanceof ServiceStillLoaded }),
    Effect.mapError((error) =>
      error instanceof ServiceStillLoaded
        ? new SpikeRuntimeError({
            cause: error,
            message: 'launchctl bootout failed: service remained loaded after bootout',
            operation: 'launchctl/bootout',
          })
        : error,
    ),
  );
});

const unloadService = Effect.fn('SpikeLifecycle.unload')(function* unloadService(
  options: ServiceLifecycleOptions,
) {
  const args = ['bootout', `${options.domain}/${options.label}`] as const;
  const result = yield* options.commands.launchctl(args);
  if (result.timedOut) {
    return yield* launchctlError(args, result);
  }
  if (result.exitCode !== 0) {
    if (serviceIsMissing(result.stderr)) {
      return yield* Effect.void;
    }
    return yield* launchctlError(args, result);
  }
  return yield* waitUntilUnloaded(options);
});

const launchService = Effect.fn('SpikeLifecycle.launch')(function* launchService(
  options: ServiceLifecycleOptions,
) {
  yield* requireSuccess(options.commands, ['bootstrap', options.domain, options.launchAgent]);
  yield* requireSuccess(options.commands, [
    'kickstart',
    '-k',
    `${options.domain}/${options.label}`,
  ]);
  return {
    label: options.label,
    ok: true,
    socket: options.socket,
    status: 'started',
  } satisfies ServiceLifecycleResult;
});

const makeServiceLifecycle = (options: ServiceLifecycleOptions): ServiceLifecycle => ({
  restart: Effect.gen(function* restartService() {
    yield* unloadService(options);
    yield* options.prepare;
    return yield* launchService(options);
  }),
  start: Effect.gen(function* startService() {
    yield* options.prepare;
    yield* unloadService(options);
    return yield* launchService(options);
  }),
  stop: unloadService(options).pipe(
    Effect.as({ label: options.label, ok: true, status: 'stopped' } as const),
  ),
});

export { classifyServiceInspection, makeServiceLifecycle, serviceIsMissing };
export type {
  ServiceInspection,
  ServiceLifecycle,
  ServiceLifecycleOptions,
  ServiceLifecycleResult,
};
