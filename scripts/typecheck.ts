#!/usr/bin/env bun
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const locator = Bun.spawnSync(['effect-tsgo', 'get-exe-path'], {
  stderr: 'inherit',
  stdout: 'pipe',
});
if (locator.exitCode !== 0) {
  process.exit(locator.exitCode ?? 1);
}

const executable = locator.stdout.toString().trim();
if (executable === '') {
  throw new Error('effect-tsgo get-exe-path returned an empty compiler path');
}

const compilerRoot = await mkdtemp(path.join(tmpdir(), 'spike-effect-tsgo-'));
const runnableCompiler = path.join(compilerRoot, 'tsgo');
let exitCode = 1;
try {
  await copyFile(executable, runnableCompiler);
  await chmod(runnableCompiler, 0o700);
  const checked = Bun.spawnSync([runnableCompiler, '--noEmit'], {
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  });
  exitCode = checked.exitCode ?? 1;
} finally {
  await rm(compilerRoot, { force: true, recursive: true });
}
process.exit(exitCode);
