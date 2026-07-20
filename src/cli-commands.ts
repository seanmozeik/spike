import { Effect } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';

import { outputMode } from './cli-flags';
import { emit, toMode } from './cli-shared';
import { serveDaemon } from './daemon';
import { SpikeRuntimeError } from './errors';
import { runOnboardingPreview } from './onboarding/preview';
import { realPrompts } from './onboarding/prompts';
import { runOnboarding } from './onboarding/run';
import { defaultServices } from './onboarding/services';
import {
  addAccount,
  accounts,
  approvals,
  doctor,
  readLogs,
  restartService,
  serviceStatus,
  startService,
  stopService,
  type AccountAddResult,
  type AccountResult,
  type LogResult,
  type ServiceStatusResult,
} from './operations';
import type { ServiceLifecycleResult } from './operator/lifecycle';
import { spikePaths } from './paths';
import { isApprovalList, type ApprovalList } from './status/approvals';
import { isDoctorReport, type DoctorReport } from './status/doctor';
import { formatDoctor, formatStatus } from './status/format';
import { isStatusSnapshot } from './status/snapshot';

type OperationCommand = Command.Command<
  string,
  { readonly agent: boolean; readonly json: boolean },
  Record<string, never>,
  SpikeRuntimeError
>;

type AccountAddCommand = Command.Command<
  'add',
  {
    readonly accountId: string;
    readonly agent: boolean;
    readonly json: boolean;
    readonly sourcePath: string;
  },
  Record<string, never>,
  SpikeRuntimeError
>;

interface OperationHandlers {
  readonly addAccount: (accountId: string, sourcePath: string) => Promise<AccountAddResult>;
  readonly accounts: () => Promise<AccountResult>;
  readonly approvals: () => Promise<ApprovalList>;
  readonly doctor: () => Promise<DoctorReport>;
  readonly logs: () => Promise<LogResult>;
  readonly restart: () => Promise<ServiceLifecycleResult>;
  readonly start: () => Promise<ServiceLifecycleResult>;
  readonly status: () => Promise<ServiceStatusResult>;
  readonly stop: () => Promise<ServiceLifecycleResult>;
}

interface OperationCommandSet {
  readonly accountsCommand: OperationCommand;
  readonly approvalsCommand: OperationCommand;
  readonly doctorCommand: OperationCommand;
  readonly logsCommand: OperationCommand;
  readonly restartCommand: OperationCommand;
  readonly startCommand: OperationCommand;
  readonly statusCommand: OperationCommand;
  readonly stopCommand: OperationCommand;
}

type SpikeCliApp = Command.Command<'spike', Record<string, never>, Record<string, never>, unknown>;

const command = <A>(
  name: string,
  description: string,
  run: () => Promise<A>,
  human: (value: A) => string = (value) => JSON.stringify(value),
): OperationCommand =>
  Command.make(name, outputMode, ({ agent, json }) => {
    const mode = toMode(agent, json);
    return Effect.tryPromise({
      catch: (cause) =>
        cause instanceof SpikeRuntimeError
          ? cause
          : new SpikeRuntimeError({
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

const makeAccountAddCommand = (handler: OperationHandlers['addAccount']): AccountAddCommand =>
  Command.make(
    'add',
    {
      ...outputMode,
      accountId: Argument.string('account-id'),
      sourcePath: Argument.string('auth-json-path'),
    },
    ({ accountId, agent, json, sourcePath }) => {
      const mode = toMode(agent, json);
      return Effect.tryPromise({
        catch: (cause) =>
          cause instanceof SpikeRuntimeError
            ? cause
            : new SpikeRuntimeError({
                cause,
                message: cause instanceof Error ? cause.message : String(cause),
                operation: 'cli/accounts-add',
              }),
        try: () => handler(accountId, sourcePath),
      }).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            emit(mode, value, () => {
              console.log(JSON.stringify(value));
            });
          }),
        ),
      );
    },
  ).pipe(Command.withDescription('Add an isolated Codex credential snapshot'));
const formatApprovals = (value: unknown): string => {
  if (!isApprovalList(value)) {
    return JSON.stringify(value);
  }
  if (value.approvals.length === 0) {
    return 'No approvals.';
  }
  return value.approvals
    .map((item) => `${item.state} · ${item.operation} · ${item.method} · ${item.id}`)
    .join('\n');
};

const makeOperationCommands = (handlers: OperationHandlers): OperationCommandSet => ({
  accountsCommand: command('list', 'Show configured Codex accounts', handlers.accounts),
  approvalsCommand: command(
    'approvals',
    'List pending and recently resolved approvals',
    handlers.approvals,
    formatApprovals,
  ),
  doctorCommand: command(
    'doctor',
    'Inspect service paths, config, and journal',
    handlers.doctor,
    (value) => (isDoctorReport(value) ? formatDoctor(value) : JSON.stringify(value)),
  ),
  logsCommand: command('logs', 'Read the daemon log', handlers.logs, (value) => value.text),
  restartCommand: command('restart', 'Restart the Spike LaunchAgent', handlers.restart),
  startCommand: command('start', 'Install and start the Spike LaunchAgent', handlers.start),
  statusCommand: command('status', 'Show compact service status', handlers.status, (value) =>
    isStatusSnapshot(value) ? formatStatus(value) : JSON.stringify(value),
  ),
  stopCommand: command('stop', 'Stop the Spike LaunchAgent', handlers.stop),
});

const liveOperationHandlers: OperationHandlers = {
  accounts,
  addAccount,
  approvals,
  doctor,
  logs: readLogs,
  restart: restartService,
  start: startService,
  status: serviceStatus,
  stop: stopService,
};

const previewFlag = Flag.boolean('preview').pipe(
  Flag.withDescription('Walk through every prompt without preflight, permissions, or writes'),
);
const initCommand = Command.make('init', { preview: previewFlag }).pipe(
  Command.withDescription('Interactively configure and verify a new Spike installation'),
  Command.withHandler(({ preview }) => {
    // Interactive onboarding keeps prompts and filesystem preparation at this Promise boundary.
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
const verboseFlag = Flag.boolean('verbose').pipe(
  Flag.withDescription('Retain diagnostic app-server logs'),
);
const serveCommand = Command.make('serve', { verbose: verboseFlag }).pipe(
  Command.withDescription('Run the foreground daemon for launchd'),
  Command.withHandler(({ verbose }) =>
    serveDaemon(spikePaths(), { logMode: verbose ? 'verbose' : 'quiet' }),
  ),
);

const makeCliApp = (handlers: OperationHandlers = liveOperationHandlers): SpikeCliApp => {
  const commands = makeOperationCommands(handlers);
  const accountsCommand = Command.make('accounts').pipe(
    Command.withDescription('Manage isolated Codex accounts'),
    Command.withSubcommands([makeAccountAddCommand(handlers.addAccount), commands.accountsCommand]),
  );
  return Command.make('spike').pipe(
    Command.withSubcommands([
      commands.startCommand,
      commands.stopCommand,
      commands.restartCommand,
      commands.statusCommand,
      commands.doctorCommand,
      initCommand,
      commands.logsCommand,
      accountsCommand,
      commands.approvalsCommand,
      serveCommand,
    ]),
  );
};

export { formatApprovals, makeCliApp, makeOperationCommands };
export type { OperationCommandSet, OperationHandlers };
