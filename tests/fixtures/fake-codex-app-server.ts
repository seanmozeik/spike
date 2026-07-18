#!/usr/bin/env bun

import { Option, Schema } from 'effect';

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

type RpcRequest = typeof RpcRequest.Type;

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

const handleRequest = async (request: RpcRequest): Promise<void> => {
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

const decodeRequest = (line: string): RpcRequest | null => {
  try {
    const decoded = Schema.decodeUnknownOption(RpcRequest)(JSON.parse(line) as unknown);
    return Option.isSome(decoded) ? decoded.value : null;
  } catch {
    return null;
  }
};

const processRequests = async (requests: readonly RpcRequest[], index = 0): Promise<void> => {
  const request = requests[index];
  if (request === undefined) {
    return;
  }
  await handleRequest(request);
  await processRequests(requests, index + 1);
};

const processBuffer = async (buffer: string): Promise<string> => {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  const requests = lines
    .map((line) => decodeRequest(line.trim()))
    .filter((request): request is RpcRequest => request !== null);
  await processRequests(requests);
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
