import { Database } from 'bun:sqlite';

const APPROVAL_LIST_LIMIT = 20;

interface ApprovalListItem {
  readonly deliveredAt: string | null;
  readonly expiresAt: string;
  readonly id: string;
  readonly method: string;
  readonly operation: string;
  readonly requestedAt: string;
  readonly resolvedAt: string | null;
  readonly state: string;
}

interface ApprovalList {
  readonly approvals: readonly ApprovalListItem[];
  readonly ok: true;
}

const readApprovalList = (database: Database, limit = APPROVAL_LIST_LIMIT): ApprovalList => ({
  approvals: database
    .query<ApprovalListItem, [number]>(
      `SELECT id, method, operation, state, requested_at AS requestedAt,
              expires_at AS expiresAt, delivered_at AS deliveredAt, resolved_at AS resolvedAt
       FROM approval_requests
       ORDER BY CASE WHEN state = 'Pending' THEN 0 ELSE 1 END, requested_at DESC LIMIT ?`,
    )
    .all(limit),
  ok: true,
});

const inspectApprovalList = (databasePath: string, limit = APPROVAL_LIST_LIMIT): ApprovalList => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return readApprovalList(database, limit);
  } finally {
    database.close();
  }
};

const isApprovalList = (value: unknown): value is ApprovalList =>
  typeof value === 'object' &&
  value !== null &&
  (value as { ok?: unknown }).ok === true &&
  Array.isArray((value as { approvals?: unknown }).approvals);

export { inspectApprovalList, isApprovalList, readApprovalList };
export type { ApprovalList, ApprovalListItem };
