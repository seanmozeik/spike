const JSON_RPC_METHOD_NOT_FOUND = -32_601;
const APPROVAL_METHODS = new Set([
  'applyPatchApproval',
  'execCommandApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);

const isId = (value: unknown): value is number | string =>
  typeof value === 'number' || typeof value === 'string';

const approvalDecision = (method: string): Record<string, unknown> =>
  method.startsWith('item/') ? { decision: 'accept' } : { decision: 'approved' };

const routeServerRequest = (
  message: Record<string, unknown>,
  write: (value: unknown) => void,
): boolean => {
  const { id } = message;
  if (!isId(id) || typeof message['method'] !== 'string') {
    return false;
  }
  const { method } = message;
  if (APPROVAL_METHODS.has(method)) {
    write({ id, jsonrpc: '2.0', result: approvalDecision(method) });
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
