import { once } from 'node:events';
import { chmod, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

import { Effect } from 'effect';

import type { SpikePaths } from './paths';
import { encodeFrame, parseControlRequest, type ServiceStatus } from './protocol';

const CONTROL_REQUEST_TIMEOUT_MS = 3000;
const MAX_FRAME_BYTES = 65_536;
const OWNER_ONLY_SOCKET_MODE = 0o600;

const writeResponse = (socket: Socket, value: unknown): void => {
  socket.end(encodeFrame(value));
};

const readRequest = (
  kind: 'approvals' | 'doctor' | 'status',
  status: () => Promise<ServiceStatus>,
  doctor: () => Promise<unknown>,
  approvals: () => Promise<unknown>,
): Promise<unknown> => {
  if (kind === 'doctor') {
    return doctor();
  }
  if (kind === 'approvals') {
    return approvals();
  }
  return status();
};

const respondToFrame = async (
  socket: Socket,
  frame: string,
  onShutdown: () => void,
  status: () => Promise<ServiceStatus>,
  doctor: () => Promise<unknown>,
  approvals: () => Promise<unknown>,
): Promise<void> => {
  try {
    const request = parseControlRequest(frame);
    if (request.kind === 'shutdown') {
      writeResponse(socket, { ok: true, stopping: true });
      onShutdown();
      return;
    }
    writeResponse(socket, await readRequest(request.kind, status, doctor, approvals));
  } catch (error) {
    writeResponse(socket, { error: String(error), ok: false });
  }
};

const startControlSocket = async (
  paths: SpikePaths,
  startedAt: string,
  onShutdown: () => void,
  status: () => Promise<ServiceStatus> = () =>
    Promise.resolve({
      codexHome: paths.codexHome,
      database: paths.database,
      ok: true,
      pid: process.pid,
      service: 'spike',
      socket: paths.socket,
      startedAt,
    }),
  doctor: () => Promise<unknown> = status,
  approvals: () => Promise<unknown> = status,
): Promise<Server> => {
  await rm(paths.socket, { force: true });
  const server = createServer((socket) => {
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
        Effect.promise(() =>
          respondToFrame(socket, buffer.slice(0, newline), onShutdown, status, doctor, approvals),
        ),
      );
    });
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
): Promise<unknown> => {
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
    return JSON.parse(buffer);
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
};

export { requestControl, startControlSocket };
