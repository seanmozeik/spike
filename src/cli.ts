#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Cause, Effect, Layer, Logger, type LogLevel, References } from 'effect';
import { CliError, Command } from 'effect/unstable/cli';

import pkg from '../package.json' with { type: 'json' };
import {
  accountsCommand,
  doctorCommand,
  initCommand,
  logsCommand,
  restartCommand,
  serveCommand,
  startCommand,
  statusCommand,
  stopCommand,
} from './cli-commands';
import { failPayload } from './output';

const JSON_INDENT = 2;
const app = Command.make('spike').pipe(
  Command.withSubcommands([
    startCommand,
    stopCommand,
    restartCommand,
    statusCommand,
    doctorCommand,
    initCommand,
    logsCommand,
    accountsCommand,
    serveCommand,
  ]),
);
const program = Command.run(app, { version: pkg.version });

const stderrLogger = Logger.make(({ logLevel, message }) => {
  const text = Array.isArray(message) ? message.map(String).join(' ') : String(message);
  process.stderr.write(`[${logLevel.toLowerCase()}] ${text}\n`);
});
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
const minLogLevel: LogLevel.LogLevel = verbose ? 'Debug' : 'Warn';
const runtimeLayer = Layer.mergeAll(
  BunServices.layer,
  Logger.layer([stderrLogger]),
  Layer.succeed(References.MinimumLogLevel, minLogLevel),
);

const showHelpHasErrors = (cause: Cause.Cause<unknown>): boolean | undefined => {
  for (const reason of cause.reasons) {
    if (
      Cause.isFailReason(reason) &&
      CliError.isCliError(reason.error) &&
      reason.error instanceof CliError.ShowHelp
    ) {
      return reason.error.errors.length > 0;
    }
  }
  return undefined;
};

const boundaryErrorFromCause = (cause: Cause.Cause<unknown>): unknown => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      return reason.error;
    }
  }
  return Cause.pretty(cause);
};

const handled = program.pipe(
  Effect.provide(runtimeLayer),
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      const helpHasErrors = showHelpHasErrors(cause);
      if (helpHasErrors !== undefined) {
        if (helpHasErrors) {
          process.exitCode = 2;
        }
        return;
      }
      const error = boundaryErrorFromCause(cause);
      const message = error instanceof Error ? error.message : String(error);
      if (process.argv.includes('--agent')) {
        console.log(JSON.stringify(failPayload(message)));
      } else if (process.argv.includes('--json')) {
        console.log(JSON.stringify(failPayload(message), null, JSON_INDENT));
      } else {
        console.error(message);
      }
      process.exitCode = 1;
    }),
  ),
);

BunRuntime.runMain(handled);
