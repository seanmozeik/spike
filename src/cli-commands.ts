import { Effect } from 'effect';
import { Command } from 'effect/unstable/cli';

import { outputMode } from './cli-flags';
import { emit, toMode } from './cli-shared';
import { serveDaemon } from './daemon';
import { SpikeRuntimeError } from './errors';
import { realPrompts } from './onboarding/prompts';
import { defaultServices, runOnboarding } from './onboarding/run';
import {
  accounts,
  doctor,
  readLogs,
  restartService,
  serviceStatus,
  startService,
  stopService,
} from './operations';
import { spikePaths } from './paths';
import { isDoctorReport } from './status/doctor';
import { formatDoctor, formatStatus } from './status/format';
import { isStatusSnapshot } from './status/snapshot';

type OperationCommand = Command.Command<
  string,
  { readonly agent: boolean; readonly json: boolean },
  Record<string, never>,
  SpikeRuntimeError
>;

const command = (
  name: string,
  description: string,
  run: () => Promise<unknown>,
  human: (value: unknown) => string = (value) => JSON.stringify(value),
): OperationCommand =>
  Command.make(name, outputMode, ({ agent, json }) => {
    const mode = toMode(agent, json);
    return Effect.tryPromise({
      catch: (cause) =>
        new SpikeRuntimeError({
          cause,
          message: cause instanceof Error ? cause.message : String(cause),
          operation: `cli/${name}`,
        }),
      try: run,
    }).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          emit(mode, value, () => {
            console.log(human(value));
          });
        }),
      ),
    );
  }).pipe(Command.withDescription(description));

const startCommand = command('start', 'Install and start the Spike LaunchAgent', startService);
const stopCommand = command('stop', 'Stop the Spike LaunchAgent', stopService);
const restartCommand = command('restart', 'Restart the Spike LaunchAgent', restartService);
const statusCommand = command('status', 'Show compact service status', serviceStatus, (value) =>
  isStatusSnapshot(value) ? formatStatus(value) : JSON.stringify(value),
);
const doctorCommand = command(
  'doctor',
  'Inspect service paths, config, and journal',
  doctor,
  (value) => (isDoctorReport(value) ? formatDoctor(value) : JSON.stringify(value)),
);
const logsCommand = command('logs', 'Read the daemon log', readLogs);
const accountsCommand = command('accounts', 'Show configured Codex accounts', accounts);
const initCommand = Command.make('init').pipe(
  Command.withDescription('Interactively configure and verify a new Spike installation'),
  Command.withHandler(() => {
    const paths = spikePaths();
    return Effect.tryPromise({
      catch: (cause) =>
        new SpikeRuntimeError({
          cause,
          message: cause instanceof Error ? cause.message : String(cause),
          operation: 'cli/init',
        }),
      try: () =>
        runOnboarding({
          paths,
          prompts: realPrompts(),
          services: defaultServices(startService, stopService, doctor, paths),
        }),
    });
  }),
);
const serveCommand = Command.make('serve').pipe(
  Command.withDescription('Run the foreground daemon for launchd'),
  Command.withHandler(() => serveDaemon(spikePaths())),
);

export {
  accountsCommand,
  doctorCommand,
  initCommand,
  logsCommand,
  restartCommand,
  serveCommand,
  startCommand,
  statusCommand,
  stopCommand,
};
