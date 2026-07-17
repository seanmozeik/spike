import { permissionSummary, type ApprovalRequest } from './model';

const MAX_DETAIL_LENGTH = 600;

const truncate = (value: string): string =>
  value.length <= MAX_DETAIL_LENGTH ? value : `${value.slice(0, MAX_DETAIL_LENGTH - 1)}…`;

const approvalPrompt = (request: ApprovalRequest): string => {
  const detail =
    request.command ??
    (request.filePaths.length > 0 ? request.filePaths.join('\n') : permissionSummary(request));
  return [
    `Permission requested: ${request.operation}`,
    detail === '' ? null : truncate(detail),
    request.cwd === null ? null : `Working directory: ${request.cwd}`,
    request.reason === null ? null : `Reason: ${truncate(request.reason)}`,
    `Expires: ${request.expiresAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
    'Reply /yes or /no',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
};

const approvalOutcome = (state: 'Approved' | 'Denied' | 'Expired' | 'Orphaned'): string => {
  if (state === 'Approved') {
    return 'Approved.';
  }
  if (state === 'Denied') {
    return 'Denied.';
  }
  if (state === 'Expired') {
    return 'Permission request expired.';
  }
  return 'Permission request was cancelled because its Codex connection ended. Please retry the operation.';
};

export { approvalOutcome, approvalPrompt };
