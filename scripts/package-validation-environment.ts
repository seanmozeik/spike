import assert from 'node:assert/strict';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { requireExit, runCommand, type CommandResult } from './package-validation-command';
import { writeExecutable } from './package-validation-fixtures';
import { changedTreePaths, snapshotTree } from './package-validation-tree';

const COMMAND_TIMEOUT_MS = 10_000;
const PREVIEW_TIMEOUT_MS = 30_000;
const EXPECT_TIMEOUT_SECONDS = 20;
const FIXED_LOCALE = 'C';
const BANNER_MARKER = '____________ |__|';
const STANDARD_EXECUTABLE_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
] as const;

const trapCommand = (name: string): string => `#!/bin/sh
if [ -n "$SPIKE_VALIDATION_TRAP_LOG" ]; then
  printf "%s\\n" "${name}" >> "$SPIKE_VALIDATION_TRAP_LOG"
  exit 97
fi
`;

const assertBannerOutput = (output: string): void => {
  assert.match(output, new RegExp(BANNER_MARKER, 'u'));
};

const expectProgram = `
set timeout ${String(EXPECT_TIMEOUT_SECONDS)}
proc await_prompt {text} {
  expect {
    -exact $text { return }
    timeout { puts stderr "timed out waiting for: $text"; exit 124 }
    eof { puts stderr "preview ended before: $text"; exit 125 }
  }
}
cd $env(SPIKE_VALIDATION_WORK)
spawn -noecho /bin/sh -c {stty rows 40 cols 120; exec env HOME="$SPIKE_VALIDATION_USER_HOME" SPIKE_HOME="$SPIKE_VALIDATION_SPIKE_HOME" BUN_INSTALL_CACHE_DIR="$SPIKE_VALIDATION_CACHE" TMPDIR="$SPIKE_VALIDATION_TMP" NO_COLOR=1 "$SPIKE_VALIDATION_CLI" init --preview}
await_prompt "Who should Spike talk to?"
send -- "spike@example.com\\r"
await_prompt "Where should Spike work by default?"
send -- "\\r"
await_prompt "How should Spike use letter case?"
send -- "\\r"
await_prompt "How should Spike use emoji?"
send -- "\\r"
await_prompt "How should Spike end short messages?"
send -- "\\r"
await_prompt "May Spike Like messages while it works?"
send -- "\\r"
await_prompt "May Spike swear?"
send -- "\\r"
await_prompt "How witty should Spike be?"
send -- "\\r"
await_prompt "How should Spike configure Codex?"
send -- "\\r"
await_prompt "Choose a Codex model"
send -- "\\r"
await_prompt "How much reasoning should Spike use?"
send -- "\\r"
await_prompt "Choose Codex’s built-in personality"
send -- "\\r"
await_prompt "Choose a service tier"
send -- "\\r"
await_prompt "When may Spike run tools?"
send -- "\\r"
await_prompt "How much filesystem access should Spike have?"
send -- "\\r"
await_prompt "What would you like Spike to call you?"
send -- "Example\\r"
await_prompt "Add personal context for Spike"
send -- "\\t\\r"
await_prompt "Finish preview?"
send -- "\\r"
await_prompt "Preview complete. Nothing was changed."
expect eof
set child_status [wait]
exit [lindex $child_status 3]
`;

const isolatedEnvironment = (
  validationRoot: string,
  spikeHome: string,
  userHome: string,
  fakeBin: string,
): Record<string, string> => {
  const temporaryDirectory = path.join(validationRoot, 'tmp');
  const executablePath = [fakeBin, path.dirname(process.execPath), ...STANDARD_EXECUTABLE_PATHS]
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .join(':');
  return {
    BUN_INSTALL_CACHE_DIR: path.join(validationRoot, 'cache', 'bun'),
    CODEX_HOME: path.join(spikeHome, 'codex-home'),
    HOME: userHome,
    LANG: FIXED_LOCALE,
    LC_ALL: FIXED_LOCALE,
    LOGNAME: 'spike-validation',
    NO_COLOR: '1',
    PATH: executablePath,
    SHELL: '/bin/sh',
    SPIKE_HOME: spikeHome,
    TEMP: temporaryDirectory,
    TERM: 'xterm-256color',
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    USER: 'spike-validation',
    XDG_CACHE_HOME: path.join(validationRoot, 'cache', 'xdg'),
    XDG_CONFIG_HOME: path.join(validationRoot, 'config', 'xdg'),
    XDG_DATA_HOME: path.join(validationRoot, 'data', 'xdg'),
    XDG_STATE_HOME: path.join(validationRoot, 'state', 'xdg'),
  };
};

const runCli = (
  cli: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  label: string,
): Promise<CommandResult> =>
  runCommand({
    argv: [cli, ...args],
    cwd,
    environment,
    label,
    recordedArgv: ['<packaged spike>', ...args],
    recordedCwd: '<temporary work directory>',
    timeoutMs: COMMAND_TIMEOUT_MS,
  });

const makeOperatorFixtures = async (fakeBin: string): Promise<void> => {
  await mkdir(fakeBin, { mode: 0o700, recursive: true });
  await Promise.all([
    writeExecutable(
      path.join(fakeBin, 'launchctl'),
      `${trapCommand('launchctl')}printf "%s\\n" "$SPIKE_HOME" CODEX_EXECUTABLE "PATH =>"\n`,
    ),
    writeExecutable(
      path.join(fakeBin, 'osascript'),
      `${trapCommand('osascript')}printf "Messages\\n"\n`,
    ),
    writeExecutable(path.join(fakeBin, 'open'), `${trapCommand('open')}exit 0\n`),
    writeExecutable(path.join(fakeBin, 'codex'), `${trapCommand('codex')}exit 0\n`),
    ...['shim', 'talon'].map((name) =>
      writeExecutable(
        path.join(fakeBin, name),
        `${trapCommand(name)}printf "%s is forbidden during package validation\\n" "${name}" >&2\nexit 98\n`,
      ),
    ),
  ]);
};

const makeFakeCodex = async (file: string): Promise<void> => {
  const source = `#!/usr/bin/env bun
let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    const response = process.env.SPIKE_VALIDATION_CODEX_MODE === 'provider-error'
      ? { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'fixture provider unavailable' } }
      : { jsonrpc: '2.0', id: request.id, result: {} };
    process.stdout.write(JSON.stringify(response) + '\\n');
  }
}
`;
  await writeExecutable(file, source);
};

const runPreview = async (
  validationRoot: string,
  cli: string,
  work: string,
  fakeBin: string,
): Promise<void> => {
  const previewHome = path.join(validationRoot, 'homes', 'preview');
  const userHome = path.join(validationRoot, 'users', 'preview');
  const trapLog = path.join(validationRoot, 'preview-boundary-violation.log');
  const environment = {
    ...isolatedEnvironment(validationRoot, previewHome, userHome, fakeBin),
    SPIKE_VALIDATION_CACHE: path.join(validationRoot, 'cache', 'preview'),
    SPIKE_VALIDATION_CLI: cli,
    SPIKE_VALIDATION_SPIKE_HOME: previewHome,
    SPIKE_VALIDATION_TMP: path.join(validationRoot, 'tmp'),
    SPIKE_VALIDATION_TRAP_LOG: trapLog,
    SPIKE_VALIDATION_USER_HOME: userHome,
    SPIKE_VALIDATION_WORK: work,
  };
  await Promise.all([
    mkdir(environment.SPIKE_VALIDATION_CACHE, { recursive: true }),
    mkdir(environment.SPIKE_VALIDATION_TMP, { recursive: true }),
    mkdir(userHome, { recursive: true }),
  ]);
  const before = await snapshotTree(validationRoot);
  const preview = await runCommand({
    argv: ['/usr/bin/expect', '-c', expectProgram],
    cwd: work,
    environment,
    label: 'packaged init --preview',
    recordedArgv: ['/usr/bin/expect', '-c', '<embedded preview program>'],
    recordedCwd: '<temporary work directory>',
    timeoutMs: PREVIEW_TIMEOUT_MS,
  });
  requireExit(preview, 0, 'packaged init --preview');
  assertBannerOutput(preview.stdout);
  await assert.rejects(lstat(trapLog));
  const changedPaths = changedTreePaths(before, await snapshotTree(validationRoot));
  assert.deepEqual(
    changedPaths,
    [],
    `packaged init --preview changed temporary filesystem entries: ${changedPaths.join(', ')}`,
  );
};

export {
  assertBannerOutput,
  COMMAND_TIMEOUT_MS,
  isolatedEnvironment,
  makeFakeCodex,
  makeOperatorFixtures,
  runCli,
  runPreview,
};
