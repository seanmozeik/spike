import { closeSync, constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  AttachmentStagingPermissionError,
  fileErrorCode,
  isFilePermissionDenied,
  SafeStagingError,
} from './errors';
import type { AttachmentFailureCode } from './model';

const DEVICE_ERROR_CODES = new Set(['ENODEV', 'ENOTSUP', 'ENXIO', 'EOPNOTSUPP']);
const DARWIN_O_NOFOLLOW_ANY = Number('536870912');

interface AttachmentSourceAccessOptions {
  readonly beforeSourceOpen?: (sourcePath: string) => void;
  readonly sourceRoot: string;
}

interface ResolvedSource {
  readonly canonicalRoot: string;
  readonly path: string;
}

type AttachmentSourceAccess =
  | { readonly code: AttachmentFailureCode; readonly kind: 'Rejected' }
  | { readonly descriptor: number; readonly kind: 'Opened'; readonly path: string };

const isDevicePathError = (cause: unknown): boolean =>
  DEVICE_ERROR_CODES.has(fileErrorCode(cause) ?? '');

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};

const sourceCandidate = (sourceRoot: string, storedPath: string): string => {
  if (storedPath.startsWith('~/')) {
    return path.resolve(homedir(), storedPath.slice(2));
  }
  if (path.isAbsolute(storedPath)) {
    return path.resolve(storedPath);
  }
  const normalized = storedPath.split(path.win32.sep).join(path.sep);
  return normalized === 'Attachments' || normalized.startsWith(`Attachments${path.sep}`)
    ? path.resolve(path.dirname(sourceRoot), normalized)
    : path.resolve(sourceRoot, normalized);
};

const symlinkFailure = (candidate: string): AttachmentFailureCode | null => {
  try {
    return lstatSync(candidate).isSymbolicLink() ? 'symlink' : null;
  } catch (error) {
    if (isFilePermissionDenied(error)) {
      throw new AttachmentStagingPermissionError({
        message:
          'Spike cannot read an attachment. Grant Full Disk Access to the Bun executable that runs spike.',
      });
    }
    if (fileErrorCode(error) === 'ENOENT') {
      return 'missing-source';
    }
    throw new SafeStagingError('failed to inspect attachment metadata');
  }
};

const rejectSymlinkComponents = (
  sourceRoot: string,
  candidate: string,
): AttachmentFailureCode | null => {
  const rootFailure = symlinkFailure(sourceRoot);
  if (rootFailure !== null) {
    return rootFailure;
  }
  const relative = path.relative(sourceRoot, candidate);
  let current = sourceRoot;
  for (const segment of relative.split(path.sep).filter((part) => part.length > 0)) {
    current = path.join(current, segment);
    const failure = symlinkFailure(current);
    if (failure !== null) {
      return failure;
    }
  }
  return null;
};

const resolveSource = (
  sourceRoot: string,
  storedPath: string,
): ResolvedSource | AttachmentSourceAccess => {
  const resolvedRoot = path.resolve(sourceRoot);
  const candidate = sourceCandidate(resolvedRoot, storedPath);
  if (!isWithin(resolvedRoot, candidate)) {
    return { code: 'outside-messages-root', kind: 'Rejected' };
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(resolvedRoot);
  } catch (error) {
    if (isFilePermissionDenied(error)) {
      throw new AttachmentStagingPermissionError({
        message:
          'Spike cannot read Messages attachments. Grant Full Disk Access to the Bun executable that runs spike.',
      });
    }
    if (fileErrorCode(error) === 'ENOENT') {
      return { code: 'missing-source', kind: 'Rejected' };
    }
    throw new SafeStagingError('failed to resolve the Messages attachment directory');
  }
  const componentFailure = rejectSymlinkComponents(resolvedRoot, candidate);
  if (componentFailure !== null) {
    return { code: componentFailure, kind: 'Rejected' };
  }
  try {
    const canonicalCandidate = realpathSync.native(candidate);
    return isWithin(canonicalRoot, canonicalCandidate)
      ? { canonicalRoot, path: canonicalCandidate }
      : { code: 'outside-messages-root', kind: 'Rejected' };
  } catch (error) {
    if (isFilePermissionDenied(error)) {
      throw new AttachmentStagingPermissionError({
        message:
          'Spike cannot read an attachment. Grant Full Disk Access to the Bun executable that runs spike.',
      });
    }
    if (fileErrorCode(error) === 'ENOENT') {
      return { code: 'missing-source', kind: 'Rejected' };
    }
    if (isDevicePathError(error)) {
      return { code: 'device-file', kind: 'Rejected' };
    }
    throw new SafeStagingError('failed to resolve an attachment');
  }
};

const openFlags = (): number =>
  constants.O_RDONLY +
  constants.O_NONBLOCK +
  (process.platform === 'darwin' ? DARWIN_O_NOFOLLOW_ANY : constants.O_NOFOLLOW);

const openResolvedSource = (source: ResolvedSource): AttachmentSourceAccess => {
  let descriptor: number;
  try {
    descriptor = openSync(source.path, openFlags());
  } catch (error) {
    if (isFilePermissionDenied(error)) {
      throw new AttachmentStagingPermissionError({
        message:
          'Spike cannot read an attachment. Grant Full Disk Access to the Bun executable that runs spike.',
      });
    }
    if (fileErrorCode(error) === 'ELOOP') {
      return { code: 'symlink', kind: 'Rejected' };
    }
    if (fileErrorCode(error) === 'ENOENT') {
      return { code: 'missing-source', kind: 'Rejected' };
    }
    if (isDevicePathError(error)) {
      return { code: 'device-file', kind: 'Rejected' };
    }
    throw new SafeStagingError('failed to open an attachment');
  }
  try {
    const descriptorPath = realpathSync.native(`/dev/fd/${String(descriptor)}`);
    if (!isWithin(source.canonicalRoot, descriptorPath)) {
      closeSync(descriptor);
      return { code: 'symlink', kind: 'Rejected' };
    }
    return { descriptor, kind: 'Opened', path: source.path };
  } catch (error) {
    closeSync(descriptor);
    if (isFilePermissionDenied(error)) {
      throw new AttachmentStagingPermissionError({
        message:
          'Spike cannot verify an attachment. Grant Full Disk Access to the Bun executable that runs spike.',
      });
    }
    throw new SafeStagingError('failed to verify an opened attachment');
  }
};

const openAttachmentSource = (
  storedPath: string,
  options: AttachmentSourceAccessOptions,
): AttachmentSourceAccess => {
  const resolved = resolveSource(options.sourceRoot, storedPath);
  if ('kind' in resolved) {
    return resolved;
  }
  options.beforeSourceOpen?.(resolved.path);
  return openResolvedSource(resolved);
};

export { openAttachmentSource };
export type { AttachmentSourceAccessOptions };
