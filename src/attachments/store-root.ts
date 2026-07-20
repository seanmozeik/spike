import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { SafeStagingError } from './errors';

const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_MARKER_NAME = '.spike-attachment-store-v1';
const OWNER_MARKER_CONTENT = 'spike-attachment-store-v1\n';

interface AttachmentStoreRoot {
  readonly boundary: string;
  readonly root: string;
}

const syncPath = (target: string): void => {
  const descriptor = openSync(target, constants.O_RDONLY + constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const inspectDirectory = (candidate: string): boolean => {
  const stat = lstatSync(candidate, { throwIfNoEntry: false });
  if (stat === undefined) {
    return false;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SafeStagingError('attachment staging ancestor is not a regular directory');
  }
  return true;
};

const relativeSegments = (boundary: string, root: string): readonly string[] => {
  const relative = path.relative(boundary, root);
  if (
    relative === '' ||
    relative === '..' ||
    path.isAbsolute(relative) ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new SafeStagingError('attachment staging root is outside its working directory');
  }
  return relative.split(path.sep);
};

const inspectAncestors = (boundary: string, root: string, create: boolean): boolean => {
  const segments = relativeSegments(boundary, root);
  let cursor = boundary;
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    if (!inspectDirectory(cursor)) {
      if (!create) {
        return false;
      }
      mkdirSync(cursor, { mode: OWNER_ONLY_DIRECTORY_MODE });
      syncPath(path.dirname(cursor));
    }
  }
  return true;
};

const inspectOwnerMarker = (root: string): boolean => {
  const marker = path.join(root, OWNER_MARKER_NAME);
  const stat = lstatSync(marker, { throwIfNoEntry: false });
  if (stat === undefined) {
    return false;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new SafeStagingError('attachment staging ownership marker is invalid');
  }
  return readFileSync(marker, 'utf8') === OWNER_MARKER_CONTENT;
};

const inspectAttachmentStoreRoot = ({ boundary, root }: AttachmentStoreRoot): boolean => {
  if (!inspectAncestors(boundary, root, false) || !inspectDirectory(root)) {
    return false;
  }
  if (!inspectOwnerMarker(root)) {
    throw new SafeStagingError('attachment staging root is not owned by Spike');
  }
  chmodSync(root, OWNER_ONLY_DIRECTORY_MODE);
  return true;
};

const initializeAttachmentStoreRoot = (root: string): void => {
  const parent = path.dirname(root);
  const temporary = path.join(parent, `.${path.basename(root)}.${randomUUID()}.tmp`);
  const marker = path.join(temporary, OWNER_MARKER_NAME);
  mkdirSync(temporary, { mode: OWNER_ONLY_DIRECTORY_MODE });
  try {
    writeFileSync(marker, OWNER_MARKER_CONTENT, { flag: 'wx', mode: OWNER_ONLY_FILE_MODE });
    syncPath(marker);
    syncPath(temporary);
    renameSync(temporary, root);
    syncPath(parent);
  } finally {
    if (lstatSync(marker, { throwIfNoEntry: false })?.isFile() === true) {
      unlinkSync(marker);
    }
    if (lstatSync(temporary, { throwIfNoEntry: false })?.isDirectory() === true) {
      rmdirSync(temporary);
    }
  }
};

const ensureAttachmentStoreRoot = (storeRoot: AttachmentStoreRoot): void => {
  const { boundary, root } = storeRoot;
  inspectAncestors(boundary, root, true);
  if (!inspectDirectory(root)) {
    initializeAttachmentStoreRoot(root);
  }
  if (!inspectAttachmentStoreRoot(storeRoot)) {
    throw new SafeStagingError('attachment staging root was not created');
  }
};

const resolveAttachmentStoreRoot = (
  stagingRoot: string,
  stagingBoundary: string,
): AttachmentStoreRoot => {
  const boundary = path.resolve(stagingBoundary);
  const root = path.resolve(stagingRoot);
  relativeSegments(boundary, root);
  realpathSync(boundary);
  return { boundary, root };
};

export { ensureAttachmentStoreRoot, inspectAttachmentStoreRoot, resolveAttachmentStoreRoot };
export type { AttachmentStoreRoot };
