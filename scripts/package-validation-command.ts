import type { CommandResult } from './package-validation-command-assertions';

interface CommandRecord {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly label: string;
  readonly stderrBytes: number;
  readonly stdoutBytes: number;
  readonly timeoutMs: number;
}

interface RunCommandOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly label: string;
  readonly recordedArgv?: readonly string[];
  readonly recordedCwd?: string;
  readonly timeoutMs: number;
}

interface ObservedCommand {
  readonly isRunning: () => boolean;
}

interface RunObservedCommandOptions extends RunCommandOptions {
  readonly observe: (command: ObservedCommand) => Promise<void>;
  readonly shutdownGraceMs: number;
}

interface OutputCapture {
  readonly cancel: () => Promise<void>;
  readonly text: Promise<string>;
}

interface OutputCaptureState {
  cancellationRequested: boolean;
  settled: boolean;
}

interface TerminationState {
  cancellation: Promise<void> | undefined;
  error: unknown;
  timedOut: boolean;
}

const commandRecords: CommandRecord[] = [];

const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;

const observationFailure = (label: string, error: unknown): Error =>
  error instanceof Error ? error : new Error(`${label} observation failed`, { cause: error });

const signalProcessGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') {
      throw error;
    }
  }
};

const killProcessGroup = (pid: number): void => {
  signalProcessGroup(pid, 'SIGKILL');
};

const decodeChunks = (chunks: readonly Uint8Array[]): string =>
  Buffer.concat(chunks).toString('utf8');

const drainOutput = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[],
  state: OutputCaptureState,
): Promise<string> => {
  try {
    const result = await reader.read();
    if (result.done) {
      return decodeChunks(chunks);
    }
    chunks.push(result.value);
    return await drainOutput(reader, chunks, state);
  } catch (error) {
    if (state.cancellationRequested) {
      return decodeChunks(chunks);
    }
    throw error;
  }
};

const collectOutput = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[],
  state: OutputCaptureState,
): Promise<string> => {
  try {
    return await drainOutput(reader, chunks, state);
  } finally {
    state.settled = true;
    reader.releaseLock();
  }
};

const captureOutput = (stream: ReadableStream<Uint8Array>): OutputCapture => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const state: OutputCaptureState = { cancellationRequested: false, settled: false };
  return {
    cancel: async () => {
      if (state.cancellationRequested || state.settled) {
        return;
      }
      state.cancellationRequested = true;
      try {
        await reader.cancel();
      } catch (error) {
        if (!state.settled) {
          throw error;
        }
      }
    },
    text: collectOutput(reader, chunks, state),
  };
};

const cancelOutputCaptures = async (
  stdout: OutputCapture,
  stderr: OutputCapture,
  state: TerminationState,
): Promise<void> => {
  try {
    await Promise.all([stdout.cancel(), stderr.cancel()]);
  } catch (error) {
    if (state.error === undefined) {
      state.error = error;
    }
  }
};

const executeCommand = async (
  options: RunCommandOptions | RunObservedCommandOptions,
): Promise<CommandResult> => {
  const startedAt = performance.now();
  const child = Bun.spawn([...options.argv], {
    cwd: options.cwd,
    detached: true,
    env: { ...options.environment },
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const stdoutCapture = captureOutput(child.stdout);
  const stderrCapture = captureOutput(child.stderr);
  const termination: TerminationState = {
    cancellation: undefined,
    error: undefined,
    timedOut: false,
  };
  const observationDeadline = 'observe' in options ? Promise.withResolvers<never>() : undefined;
  const timeout = setTimeout(() => {
    termination.timedOut = true;
    termination.cancellation = cancelOutputCaptures(stdoutCapture, stderrCapture, termination);
    try {
      killProcessGroup(child.pid);
    } catch (error) {
      termination.error = error;
      child.kill('SIGKILL');
    }
    observationDeadline?.reject(
      new Error(`${options.label} exceeded its ${String(options.timeoutMs)}ms timeout`),
    );
  }, options.timeoutMs);
  try {
    let observationError: unknown;
    if ('observe' in options) {
      try {
        if (observationDeadline === undefined) {
          throw new Error('observed command is missing its deadline');
        }
        await Promise.race([
          options.observe({ isRunning: () => child.exitCode === null }),
          observationDeadline.promise,
        ]);
      } catch (error) {
        observationError = error;
      }
      if (!termination.timedOut && child.exitCode === null) {
        try {
          child.kill('SIGTERM');
        } catch (error) {
          observationError ??= error;
          killProcessGroup(child.pid);
        }
        await Promise.race([
          child.exited.then(() => true),
          Bun.sleep(options.shutdownGraceMs).then(() => false),
        ]);
        killProcessGroup(child.pid);
      }
    }
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      stdoutCapture.text,
      stderrCapture.text,
    ]);
    if (termination.cancellation !== undefined) {
      await termination.cancellation;
    }
    commandRecords.push({
      argv: options.recordedArgv ?? options.argv,
      cwd: options.recordedCwd ?? options.cwd,
      durationMs: Math.round(performance.now() - startedAt),
      exitCode,
      label: options.label,
      stderrBytes: Buffer.byteLength(stderr),
      stdoutBytes: Buffer.byteLength(stdout),
      timeoutMs: options.timeoutMs,
    });
    if (termination.timedOut) {
      if (termination.error !== undefined) {
        throw new Error(`${options.label} could not terminate its process group`, {
          cause: termination.error,
        });
      }
      throw new Error(`${options.label} exceeded its ${String(options.timeoutMs)}ms timeout`);
    }
    if (observationError !== undefined) {
      throw observationFailure(options.label, observationError);
    }
    return { exitCode, stderr, stdout };
  } finally {
    clearTimeout(timeout);
  }
};

const runCommand = (options: RunCommandOptions): Promise<CommandResult> => executeCommand(options);

const runObservedCommand = (options: RunObservedCommandOptions): Promise<CommandResult> =>
  executeCommand(options);

const recordedCommands = (): readonly CommandRecord[] => [...commandRecords];

export { recordedCommands, runCommand, runObservedCommand };
export {
  requireExit,
  requireFailureContaining,
  requireFailureExactly,
  type CommandResult,
} from './package-validation-command-assertions';
