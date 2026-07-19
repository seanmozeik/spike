import { Effect } from 'effect';

import { SpikeRuntimeError } from '../errors';
import { runLaunchctl, type ProcessResult } from '../launchd';

type LaunchctlArguments =
  | readonly ['bootout', string]
  | readonly ['bootstrap', string, string]
  | readonly ['kickstart', '-k', string]
  | readonly ['print', string];

interface OperatorCommandPort {
  readonly accessibilityStatus: (
    helperPath: string,
  ) => Effect.Effect<ProcessResult, SpikeRuntimeError>;
  readonly launchctl: (args: LaunchctlArguments) => Effect.Effect<ProcessResult, SpikeRuntimeError>;
  readonly messagesAutomation: Effect.Effect<ProcessResult, SpikeRuntimeError>;
}

const AUTOMATION_TIMEOUT_MS = 3000;
const ACCESSIBILITY_TIMEOUT_MS = 3000;
const MESSAGES_AUTOMATION_ARGUMENTS = [
  'osascript',
  '-e',
  'tell application "Messages" to get name',
] as const;

const commandError = (
  operation: string,
  argv: readonly string[],
  cause: unknown,
): SpikeRuntimeError =>
  new SpikeRuntimeError({
    cause: { argv, cause },
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });

const makeLiveOperatorCommands = (): OperatorCommandPort => ({
  accessibilityStatus: (helperPath): Effect.Effect<ProcessResult, SpikeRuntimeError> => {
    const argv = [helperPath, '--status'] as const;
    return Effect.try({
      catch: (cause) => commandError('operator/accessibility-status', argv, cause),
      try: () => {
        const result = Bun.spawnSync([...argv], {
          stderr: 'pipe',
          stdout: 'pipe',
          timeout: ACCESSIBILITY_TIMEOUT_MS,
        });
        return {
          exitCode: result.exitCode,
          signalCode: result.signalCode ?? null,
          stderr: result.stderr.toString(),
          stdout: result.stdout.toString(),
          timedOut: result.exitedDueToTimeout === true,
        };
      },
    });
  },
  launchctl: (args): Effect.Effect<ProcessResult, SpikeRuntimeError> =>
    Effect.try({
      catch: (cause) => commandError('operator/launchctl', ['launchctl', ...args], cause),
      try: () => runLaunchctl(args),
    }),
  messagesAutomation: Effect.try({
    catch: (cause) =>
      commandError('operator/messages-automation', MESSAGES_AUTOMATION_ARGUMENTS, cause),
    try: () => {
      const result = Bun.spawnSync([...MESSAGES_AUTOMATION_ARGUMENTS], {
        stderr: 'pipe',
        stdout: 'pipe',
        timeout: AUTOMATION_TIMEOUT_MS,
      });
      return {
        exitCode: result.exitCode,
        signalCode: result.signalCode ?? null,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
        timedOut: result.exitedDueToTimeout === true,
      };
    },
  }),
});

const liveOperatorCommands = makeLiveOperatorCommands();

export { liveOperatorCommands, makeLiveOperatorCommands };
export type { LaunchctlArguments, OperatorCommandPort };
