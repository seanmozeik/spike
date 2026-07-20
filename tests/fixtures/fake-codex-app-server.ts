#!/usr/bin/env bun

import { Option, Schema } from 'effect';

import { handleDaemonNotification, makeFakeCodexDaemonHandler } from './fake-codex-daemon';

const EXIT_CODE = 17;
const INVALID_USAGE_CODE = 64;
const SPLIT_DELAY_MS = 5;
const LATE_RESPONSE_DELAY_MS = 50;
const SCRIPTED_ERROR_CODE = -32_000;
const ORPHAN_RESPONSE_ID = 999_999;

const RpcRequest = Schema.Struct({
  id: Schema.Union([Schema.Finite, Schema.String]),
  jsonrpc: Schema.Literal('2.0'),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
const RpcNotification = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
const StderrParams = Schema.Struct({ lines: Schema.Array(Schema.String) });

type RpcRequest = typeof RpcRequest.Type;
type RpcNotification = typeof RpcNotification.Type;
type RpcInput =
  | { readonly kind: 'Notification'; readonly value: RpcNotification }
  | { readonly kind: 'Request'; readonly value: RpcRequest };

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const writeSplit = async (request: RpcRequest): Promise<void> => {
  const line = `${JSON.stringify({ id: request.id, jsonrpc: '2.0', result: 'split' })}\n`;
  const midpoint = Math.floor(line.length / 2);
  process.stdout.write(line.slice(0, midpoint));
  await Bun.sleep(SPLIT_DELAY_MS);
  process.stdout.write(line.slice(midpoint));
};

const batch: RpcRequest[] = [];
const timers = new Set<ReturnType<typeof setTimeout>>();

const schedule = (delayMs: number, action: () => void): void => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    action();
  }, delayMs);
  timers.add(timer);
};

const writeBatch = (): void => {
  if (batch.length < 2) {
    return;
  }
  const frames = batch
    .splice(0)
    .map((request) => ({ id: request.id, jsonrpc: '2.0', result: request.params }));
  process.stdout.write(
    frames
      .map((frame) => JSON.stringify(frame))
      .join('\n')
      .concat('\n'),
  );
};

const writeSpawnResult = (request: RpcRequest): void => {
  writeJson({
    id: request.id,
    jsonrpc: '2.0',
    result: { argv: Bun.argv.slice(2), codexHome: process.env['CODEX_HOME'] },
  });
};

const writeErrorResult = (request: RpcRequest): void => {
  writeJson({
    error: { code: SCRIPTED_ERROR_CODE, message: 'scripted failure' },
    id: request.id,
    jsonrpc: '2.0',
  });
};

const writeNoiseThenResult = (request: RpcRequest): void => {
  process.stdout.write('not-json\n');
  writeJson({ id: ORPHAN_RESPONSE_ID, jsonrpc: '2.0', result: 'orphan' });
  writeJson({ jsonrpc: '2.0', unexpected: true });
  writeJson({ id: request.id, jsonrpc: '2.0', result: 'after-noise' });
};

const writeStderr = (request: RpcRequest): void => {
  const decoded = Schema.decodeUnknownOption(StderrParams)(request.params);
  if (Option.isNone(decoded)) {
    return;
  }
  for (const line of decoded.value.lines) {
    process.stderr.write(`${line}\n`);
  }
  writeJson({ id: request.id, jsonrpc: '2.0', result: null });
};

const observeHang = (request: RpcRequest): void => {
  writeJson({ jsonrpc: '2.0', method: 'test/hang-observed', params: { id: request.id } });
};

const scheduleLateResult = (request: RpcRequest): void => {
  schedule(LATE_RESPONSE_DELAY_MS, () => {
    writeJson({ id: request.id, jsonrpc: '2.0', result: 'late' });
    writeJson({
      jsonrpc: '2.0',
      method: 'test/late-frame-written',
      params: { requestId: request.id },
    });
  });
};

const exitChild = (): never => process.exit(EXIT_CODE);

const daemonOptions = { exitChild, schedule, writeJson };
const handleDaemonRequest = makeFakeCodexDaemonHandler(daemonOptions);

const handleRequest = async (request: RpcRequest): Promise<void> => {
  if (handleDaemonRequest(request)) {
    return;
  }
  switch (request.method) {
    case 'test/spawn': {
      writeSpawnResult(request);
      return;
    }
    case 'test/success': {
      writeJson({ id: request.id, jsonrpc: '2.0', result: request.params });
      return;
    }
    case 'test/error': {
      writeErrorResult(request);
      return;
    }
    case 'test/stderr': {
      writeStderr(request);
      return;
    }
    case 'test/split': {
      await writeSplit(request);
      return;
    }
    case 'test/batch': {
      batch.push(request);
      writeBatch();
      return;
    }
    case 'test/noise': {
      writeNoiseThenResult(request);
      return;
    }
    case 'test/hang': {
      observeHang(request);
      return;
    }
    case 'test/late': {
      scheduleLateResult(request);
      return;
    }
    case 'test/exit': {
      return exitChild();
    }
    default: {
      break;
    }
  }
};

const decodeInput = (line: string): RpcInput | null => {
  try {
    const parsed = JSON.parse(line) as unknown;
    const request = Schema.decodeUnknownOption(RpcRequest)(parsed);
    if (Option.isSome(request)) {
      return { kind: 'Request', value: request.value };
    }
    const notification = Schema.decodeUnknownOption(RpcNotification)(parsed);
    return Option.isSome(notification) ? { kind: 'Notification', value: notification.value } : null;
  } catch {
    return null;
  }
};

const processInputs = async (inputs: readonly RpcInput[], index = 0): Promise<void> => {
  const input = inputs[index];
  if (input === undefined) {
    return;
  }
  if (input.kind === 'Request') {
    await handleRequest(input.value);
  } else {
    handleDaemonNotification(input.value.method, daemonOptions);
  }
  await processInputs(inputs, index + 1);
};

const processBuffer = async (buffer: string): Promise<string> => {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  const inputs = lines
    .map((line) => decodeInput(line.trim()))
    .filter((input): input is RpcInput => input !== null);
  await processInputs(inputs);
  return remainder;
};

const run = async (): Promise<void> => {
  const expectedArguments = ['app-server', '--listen', 'stdio://'];
  if (JSON.stringify(Bun.argv.slice(2)) !== JSON.stringify(expectedArguments)) {
    process.stderr.write(`unexpected arguments: ${JSON.stringify(Bun.argv.slice(2))}\n`);
    process.exit(INVALID_USAGE_CODE);
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = await processBuffer(buffer);
  }
  for (const timer of timers) {
    clearTimeout(timer);
  }
};

await run();
