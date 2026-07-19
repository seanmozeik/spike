import { once } from 'node:events';
import { chmod, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

import { Effect } from 'effect';

import type { AccountAddResult, AccountResult } from './codex/account-control';
import type { SpikePaths } from './paths';
import {
  encodeFrame,
  parseControlRequest,
  parseControlResponse,
  type ControlSuccessResponse,
  type ServiceStatus,
} from './protocol';

const CONTROL_REQUEST_TIMEOUT_MS = 3000;
const MAX_FRAME_BYTES = 65_536;
const OWNER_ONLY_SOCKET_MODE = 0o600;

interface AccountControlHandlers {
  readonly add: (accountId: string, sourcePath: string) => Promise<AccountAddResult>;
  readonly list: () => Promise<AccountResult>;
}

interface ControlHandlers {
  readonly accounts: AccountControlHandlers;
  readonly approvals: () => Promise<unknown>;
  readonly doctor: () => Promise<unknown>;
  readonly onShutdown: () => void;
  readonly status: () => Promise<ServiceStatus>;
}

type StartControlSocketHandlers = readonly [
  onShutdown: () => void,
  status?: () => Promise<ServiceStatus>,
  doctor?: () => Promise<unknown>,
  approvals?: () => Promise<unknown>,
  accounts?: AccountControlHandlers,
];

const writeResponse = (socket: Socket, value: unknown): void => {
  socket.end(encodeFrame(value));
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readRequest = (
  request: Exclude<ReturnType<typeof parseControlRequest>, { readonly kind: 'shutdown' }>,
  handlers: ControlHandlers,
): Promise<unknown> => {
  if (request.kind === 'doctor') {
    return handlers.doctor();
  }
  if (request.kind === 'approvals') {
    return handlers.approvals();
  }
  if (request.kind === 'accounts-list') {
    return handlers.accounts.list();
  }
  if (request.kind === 'accounts-add') {
    return handlers.accounts.add(request.accountId, request.sourcePath);
  }
  return handlers.status();
};

const respondToFrame = async (
  socket: Socket,
  frame: string,
  handlers: ControlHandlers,
): Promise<void> => {
  try {
    const request = parseControlRequest(frame);
    if (request.kind === 'shutdown') {
      writeResponse(socket, { ok: true, stopping: true });
      handlers.onShutdown();
      return;
    }
    writeResponse(socket, await readRequest(request, handlers));
  } catch (error) {
    writeResponse(socket, { error: errorMessage(error), ok: false });
  }
};

const defaultStatus =
  (paths: SpikePaths, startedAt: string): (() => Promise<ServiceStatus>) =>
  () =>
    Promise.resolve({
      codexHome: paths.codexHome,
      database: paths.database,
      ok: true,
      pid: process.pid,
      service: 'spike',
      socket: paths.socket,
      startedAt,
    });

const unavailableAccounts: AccountControlHandlers = {
  add: () => Promise.reject(new Error('account controls are unavailable')),
  list: () => Promise.reject(new Error('account controls are unavailable')),
};

const resolveHandlers = (
  paths: SpikePaths,
  startedAt: string,
  handlers: StartControlSocketHandlers,
): ControlHandlers => {
  const [onShutdown, statusOverride, doctorOverride, approvalsOverride, accountsOverride] =
    handlers;
  const status = statusOverride ?? defaultStatus(paths, startedAt);
  return {
    accounts: accountsOverride ?? unavailableAccounts,
    approvals: approvalsOverride ?? status,
    doctor: doctorOverride ?? status,
    onShutdown,
    status,
  };
};

const attachRequestReader = (socket: Socket, handlers: ControlHandlers): void => {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += String(chunk);
    if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
      writeResponse(socket, { error: 'control frame exceeds 65536 bytes', ok: false });
      return;
    }
    const newline = buffer.indexOf('\n');
    if (newline === -1) {
      return;
    }
    Effect.runFork(
      Effect.promise(() => respondToFrame(socket, buffer.slice(0, newline), handlers)),
    );
  });
};

const startControlSocket = async (
  paths: SpikePaths,
  startedAt: string,
  ...handlerArguments: StartControlSocketHandlers
): Promise<Server> => {
  await rm(paths.socket, { force: true });
  const handlers = resolveHandlers(paths, startedAt, handlerArguments);
  const server = createServer((socket) => {
    attachRequestReader(socket, handlers);
  });
  server.listen(paths.socket);
  await once(server, 'listening');
  await chmod(paths.socket, OWNER_ONLY_SOCKET_MODE);
  return server;
};

interface RequestControlOptions {
  readonly timeoutMs?: number;
}

const requestControl = async (
  socketPath: string,
  request: unknown,
  options: RequestControlOptions = {},
): Promise<ControlSuccessResponse> => {
  const timeoutMs = options.timeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS;
  const socket = createConnection(socketPath);
  const timeout = setTimeout(() => {
    socket.destroy(new Error('control socket timed out'));
  }, timeoutMs);
  let buffer = '';
  try {
    socket.setEncoding('utf8');
    await once(socket, 'connect');
    socket.write(encodeFrame(request));
    for await (const chunk of socket) {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        throw new Error('control response exceeds 65536 bytes');
      }
    }
    return parseControlResponse(buffer);
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
};

export { requestControl, startControlSocket };
