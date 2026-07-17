import type { CodexServerRequest } from './server-request-registry';

const JSON_RPC_METHOD_NOT_FOUND = -32_601;

const APPROVAL_METHODS = new Set([
  'applyPatchApproval',
  'execCommandApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

const isId = (value: unknown): value is number | string =>
  typeof value === 'number' || typeof value === 'string';

const routeServerRequest = (
  message: Record<string, unknown>,
  publish: (request: CodexServerRequest) => void,
  write: (value: unknown) => void,
): boolean => {
  const { id } = message;
  if (!isId(id) || typeof message['method'] !== 'string') {
    return false;
  }
  const { method } = message;
  if (APPROVAL_METHODS.has(method)) {
    publish({ id, method, params: message['params'] });
  } else {
    write({
      error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `method ${method} not implemented` },
      id,
      jsonrpc: '2.0',
    });
  }
  return true;
};

export { routeServerRequest };
