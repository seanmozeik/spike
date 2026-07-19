import {
  ATTACHMENT_STAGING_DIAGNOSTIC,
  inspectAttachmentStagingDiagnostic,
} from '../journal/attachment-diagnostic';
import type { SpikePaths } from '../paths';

interface AttachmentStagingCheck {
  readonly detail: string;
  readonly name: 'attachment staging';
  readonly state: 'fail' | 'pass';
}

const result = (
  state: AttachmentStagingCheck['state'],
  detail: string,
): AttachmentStagingCheck => ({ detail, name: 'attachment staging', state });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const liveAttachmentStagingCheck = (
  status: Record<string, unknown>,
): AttachmentStagingCheck | null => {
  const live = isObject(status['attachments']) ? status['attachments'] : null;
  if (typeof live?.['available'] !== 'boolean') {
    return null;
  }
  const { available } = live;
  if (available) {
    return result('pass', 'available');
  }
  return result(
    'fail',
    typeof live['diagnostic'] === 'string' ? live['diagnostic'] : ATTACHMENT_STAGING_DIAGNOSTIC,
  );
};

const attachmentStagingCheck = (
  paths: SpikePaths,
  status: Record<string, unknown>,
): AttachmentStagingCheck => {
  const live = liveAttachmentStagingCheck(status);
  if (live !== null) {
    return live;
  }
  try {
    const diagnostic = inspectAttachmentStagingDiagnostic(paths.database);
    return result(diagnostic === null ? 'pass' : 'fail', diagnostic?.diagnostic ?? 'available');
  } catch (error) {
    return result('fail', error instanceof Error ? error.message : String(error));
  }
};

export { attachmentStagingCheck };
export type { AttachmentStagingCheck };
