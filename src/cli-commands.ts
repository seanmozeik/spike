import { Effect } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { outputMode } from './cli-flags';
import { emit, toMode } from './cli-shared';
import { serveDaemon } from './daemon';
import { SpikeRuntimeError } from './errors';
import { runOnboardingPreview } from './onboarding/preview';
import { realPrompts } from './onboarding/prompts';
import { runOnboarding } from './onboarding/run';
import { defaultServices } from './onboarding/services';
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
const previewFlag = Flag.boolean('preview').pipe(
  Flag.withDescription('Walk through every prompt without preflight, permissions, or writes'),
);
const initCommand = Command.make('init', { preview: previewFlag }).pipe(
  Command.withDescription('Interactively configure and verify a new Spike installation'),
  Command.withHandler(({ preview }) => {
    return Effect.tryPromise({
      catch: (cause) =>
        new SpikeRuntimeError({
          cause,
          message: cause instanceof Error ? cause.message : String(cause),
          operation: 'cli/init',
        }),
      try: () => {
        if (preview) {
          return runOnboardingPreview(realPrompts('preview'));
        }
        const paths = spikePaths();
        return runOnboarding({
          paths,
          prompts: realPrompts(),
          services: defaultServices(startService, stopService, doctor, paths),
        });
      },
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
