#!/usr/bin/env bun

import { writeFileSync } from 'node:fs';
import path from 'node:path';

const INVALID_USAGE_CODE = 64;
const INVALID_SCRIPT_CODE = 65;
const SCRIPTED_FAILURE_CODE = 23;
const HANG_MS = 86_400_000;
const TEST_CHAT_GUID = 'any;-;+15555550199';
const SEND_SCRIPT = `on run argv
  tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)
end run`;

const failUsage = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(INVALID_USAGE_CODE);
};

const splitInstruction = (text: string): readonly [string, string | undefined] => {
  const separator = text.indexOf('\t');
  return separator === -1
    ? [text, undefined]
    : [text.slice(0, separator), text.slice(separator + 1)];
};

const validateInvocation = async (): Promise<string> => {
  const [scriptArgument, text, chatGuid, extra] = Bun.argv.slice(2);
  if (
    scriptArgument !== '-' ||
    text === undefined ||
    chatGuid !== TEST_CHAT_GUID ||
    extra !== undefined
  ) {
    return failUsage(`unexpected arguments: ${JSON.stringify(Bun.argv.slice(2))}`);
  }
  if ((await Bun.stdin.text()) !== SEND_SCRIPT) {
    process.stderr.write('unexpected AppleScript on stdin\n');
    process.exit(INVALID_SCRIPT_CODE);
  }
  return text;
};

const hangUntilKilled = async (
  root: string | undefined,
  ignoreTermination: boolean,
): Promise<never> => {
  if (root === undefined) {
    return failUsage('hang mode requires a marker directory');
  }
  writeFileSync(path.join(root, 'pid'), String(process.pid));
  process.on('SIGTERM', () => {
    writeFileSync(path.join(root, 'term-received'), 'term-received');
    if (!ignoreTermination) {
      writeFileSync(path.join(root, 'terminated'), 'terminated');
      process.exit(0);
    }
  });
  writeFileSync(path.join(root, 'started'), 'started');
  await Bun.sleep(HANG_MS);
  throw new Error('hang fixture completed without receiving SIGTERM');
};

const run = async (): Promise<void> => {
  const [mode, root] = splitInstruction(await validateInvocation());
  switch (mode) {
    case 'success': {
      return;
    }
    case 'failure': {
      process.stderr.write('scripted osascript failure\n');
      return process.exit(SCRIPTED_FAILURE_CODE);
    }
    case 'hang': {
      await hangUntilKilled(root, false);
      return;
    }
    case 'ignore-term': {
      await hangUntilKilled(root, true);
      return;
    }
    default: {
      return failUsage(`unknown mode: ${mode}`);
    }
  }
};

await run();
