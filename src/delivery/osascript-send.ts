import { Effect } from 'effect';

const SEND_SCRIPT = `on run argv
  tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)
end run`;

type SendBoundary = (chatGuid: string, text: string) => Effect.Effect<void, unknown>;

type OsascriptCommand = readonly [string, ...string[]];

interface OsascriptSendOptions {
  readonly command?: OsascriptCommand;
  readonly terminationGraceMs?: number;
  readonly timeoutMs?: number;
}

const SEND_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1000;
const OSASCRIPT_COMMAND: OsascriptCommand = ['osascript'];

type SendProcess = Bun.Subprocess<Uint8Array, 'ignore', 'pipe'>;

interface SendProcessHandle {
  readonly process: SendProcess;
  readonly stderr: Promise<string>;
}

const waitForExit = async (process: SendProcess, timeoutMs: number): Promise<number | null> => {
  const deadline = Promise.withResolvers<null>();
  const timer = setTimeout(() => {
    deadline.resolve(null);
  }, timeoutMs);
  try {
    return await Promise.race([process.exited, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
};

const hardKillAndReap = async (handle: SendProcessHandle): Promise<void> => {
  if (handle.process.exitCode === null) {
    handle.process.kill('SIGKILL');
  }
  await Promise.all([handle.process.exited, handle.stderr]);
};

const terminateAfterTimeout = async (
  handle: SendProcessHandle,
  terminationGraceMs: number,
): Promise<void> => {
  handle.process.kill('SIGTERM');
  if ((await waitForExit(handle.process, terminationGraceMs)) === null) {
    handle.process.kill('SIGKILL');
  }
  await Promise.all([handle.process.exited, handle.stderr]);
};

const runProcess = async (
  handle: SendProcessHandle,
  timeoutMs: number,
  terminationGraceMs: number,
): Promise<void> => {
  const exitCode = await waitForExit(handle.process, timeoutMs);
  if (exitCode === null) {
    await terminateAfterTimeout(handle, terminationGraceMs);
    throw new Error(`osascript send timed out after ${timeoutMs}ms`);
  }
  const stderr = await handle.stderr;
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `osascript exit ${exitCode}`);
  }
};

const acquireProcess = (
  chatGuid: string,
  text: string,
  command: OsascriptCommand,
): Effect.Effect<SendProcessHandle, unknown> =>
  Effect.try({
    catch: (cause) => cause,
    try: () => {
      const process = Bun.spawn({
        cmd: [...command, '-', text, chatGuid],
        stderr: 'pipe',
        stdin: Buffer.from(SEND_SCRIPT),
        stdout: 'ignore',
      });
      return { process, stderr: new Response(process.stderr).text() };
    },
  });

const useProcess = (
  handle: SendProcessHandle,
  timeoutMs: number,
  terminationGraceMs: number,
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    catch: (cause) => cause,
    try: () => runProcess(handle, timeoutMs, terminationGraceMs),
  });

const releaseProcess = (handle: SendProcessHandle): Effect.Effect<void, unknown> =>
  Effect.tryPromise({ catch: (cause) => cause, try: () => hardKillAndReap(handle) });

const makeOsascriptSendBoundary = (options: OsascriptSendOptions = {}): SendBoundary => {
  const command = options.command ?? OSASCRIPT_COMMAND;
  const terminationGraceMs = options.terminationGraceMs ?? TERMINATION_GRACE_MS;
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  return (chatGuid, text) =>
    Effect.acquireUseRelease(
      acquireProcess(chatGuid, text, command),
      (handle) => useProcess(handle, timeoutMs, terminationGraceMs),
      releaseProcess,
    ).pipe(Effect.withSpan('SpikeDelivery.osascriptSend'));
};

export { makeOsascriptSendBoundary };
export type { SendBoundary };
