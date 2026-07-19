import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SPLIT_DELAY_MS = 5;
const LATE_RESPONSE_DELAY_MS = 50;
const EXIT_AFTER_INITIALIZE_MARKER = '.exit-after-initialize';
const EXIT_DURING_TURN_MARKER = '.exit-during-turn';
const EXIT_DURING_UNAVAILABLE_TURN_MARKER = '.exit-during-unavailable-turn';
const ALLOW_UNAVAILABLE_TURN_EXIT_MARKER = '.allow-unavailable-turn-exit';
const FAIL_PRIMARY_CAPACITY_MARKER = '.fail-primary-capacity';

interface RpcRequest {
  readonly id: number | string;
  readonly method: string;
}

interface FakeCodexDaemonOptions {
  readonly exitChild: () => never;
  readonly schedule: (delayMs: number, action: () => void) => void;
  readonly writeJson: (value: unknown) => void;
}

const markerExists = (marker: string): boolean => {
  const codexHome = process.env['CODEX_HOME'];
  return codexHome !== undefined && existsSync(path.join(codexHome, marker));
};

const activeAccount = (): string | null => {
  try {
    const value: unknown = JSON.parse(
      readFileSync(path.join(process.env['CODEX_HOME'] ?? '', 'auth.json'), 'utf8'),
    );
    return typeof value === 'object' && value !== null && 'account' in value
      ? String(value.account)
      : null;
  } catch {
    return null;
  }
};

const exitWhenUnavailableTurnReleased = (options: FakeCodexDaemonOptions): void => {
  if (markerExists(ALLOW_UNAVAILABLE_TURN_EXIT_MARKER)) {
    options.exitChild();
  }
  options.schedule(SPLIT_DELAY_MS, () => {
    exitWhenUnavailableTurnReleased(options);
  });
};

const handleInitializeRequest = (request: RpcRequest, options: FakeCodexDaemonOptions): boolean => {
  if (request.method !== 'initialize') {
    return false;
  }
  options.writeJson({ id: request.id, jsonrpc: '2.0', result: {} });
  if (markerExists(EXIT_AFTER_INITIALIZE_MARKER)) {
    options.schedule(SPLIT_DELAY_MS, options.exitChild);
  }
  return true;
};

const handleThreadRequest = (request: RpcRequest, options: FakeCodexDaemonOptions): boolean => {
  if (request.method === 'thread/start') {
    options.writeJson({
      id: request.id,
      jsonrpc: '2.0',
      result: { thread: { id: 'daemon-thread' } },
    });
    return true;
  }
  if (request.method === 'thread/resume') {
    options.writeJson({ id: request.id, jsonrpc: '2.0', result: {} });
    return true;
  }
  if (request.method === 'thread/read') {
    options.writeJson({
      id: request.id,
      jsonrpc: '2.0',
      result: { thread: { id: 'daemon-thread', turns: [] } },
    });
    return true;
  }
  if (request.method === 'thread/loaded/list') {
    options.writeJson({ id: request.id, jsonrpc: '2.0', result: { data: [] } });
    return true;
  }
  return false;
};

const handleTurnRequest = (request: RpcRequest, options: FakeCodexDaemonOptions): boolean => {
  if (request.method !== 'turn/start') {
    return false;
  }
  if (markerExists(FAIL_PRIMARY_CAPACITY_MARKER) && activeAccount() === 'primary') {
    options.writeJson({
      error: { code: 429, message: 'rate limit exhausted' },
      id: request.id,
      jsonrpc: '2.0',
    });
    return true;
  }
  options.writeJson({ id: request.id, jsonrpc: '2.0', result: { turn: { id: 'daemon-turn' } } });
  if (markerExists(EXIT_DURING_TURN_MARKER)) {
    options.schedule(LATE_RESPONSE_DELAY_MS, options.exitChild);
  }
  if (markerExists(EXIT_DURING_UNAVAILABLE_TURN_MARKER)) {
    exitWhenUnavailableTurnReleased(options);
  }
  return true;
};

const handleAccountRequest = (request: RpcRequest, options: FakeCodexDaemonOptions): boolean => {
  if (request.method === 'account/rateLimits/read' || request.method === 'account/usage/read') {
    options.writeJson({ id: request.id, jsonrpc: '2.0', result: {} });
    return true;
  }
  if (request.method === 'account/read') {
    options.writeJson({ id: request.id, jsonrpc: '2.0', result: { account: activeAccount() } });
    return true;
  }
  return false;
};

const makeFakeCodexDaemonHandler =
  (options: FakeCodexDaemonOptions): ((request: RpcRequest) => boolean) =>
  (request): boolean =>
    handleInitializeRequest(request, options) ||
    handleThreadRequest(request, options) ||
    handleTurnRequest(request, options) ||
    handleAccountRequest(request, options);

export { makeFakeCodexDaemonHandler };
