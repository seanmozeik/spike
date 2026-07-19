import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  type BigIntStats,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { fileErrorCode, SafeStagingError } from './errors';
import type { StagedImageAttachment } from './model';

const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const FILE_MODE_MODULUS = 0x10_00n;
const OWNER_ONLY_FILE_MODE_BIGINT = 0o600n;
const SINGLE_LINK = 1n;
const CAS_NAME = /^[a-f0-9]{64}\.(?:gif|jpg|png|webp)$/u;
const TEMPORARY_NAME = /^\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/u;

interface AttachmentStore {
  readonly audit: (reference: AttachmentAuditReference) => boolean;
  readonly persist: (
    bytes: Uint8Array,
    hash: string,
    extension: '.gif' | '.jpg' | '.png' | '.webp',
  ) => string;
  readonly remove: (stagedPath: string) => void;
  readonly sweep: (referencedPaths: readonly string[]) => number;
}

interface AttachmentAuditReference {
  readonly contentHash: string;
  readonly mimeType: StagedImageAttachment['mimeType'];
  readonly path: string;
  readonly totalBytes: number;
}

const MIME_EXTENSION = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
} as const satisfies Record<StagedImageAttachment['mimeType'], string>;

const syncPath = (target: string): void => {
  const descriptor = openSync(target, constants.O_RDONLY + constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const inspectRoot = (root: string): boolean => {
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (stat === undefined) {
    return false;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SafeStagingError('attachment staging root is not a regular directory');
  }
  chmodSync(root, OWNER_ONLY_DIRECTORY_MODE);
  return true;
};

const ensureRoot = (root: string): void => {
  mkdirSync(root, { mode: OWNER_ONLY_DIRECTORY_MODE, recursive: true });
  if (!inspectRoot(root)) {
    throw new SafeStagingError('attachment staging root was not created');
  }
};

const directChild = (root: string, candidate: string): string => {
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== root || !CAS_NAME.test(path.basename(resolved))) {
    throw new SafeStagingError('invalid staged attachment path');
  }
  return resolved;
};

const inspectFile = (candidate: string): boolean => {
  const stat = lstatSync(candidate, { throwIfNoEntry: false });
  if (stat === undefined) {
    return false;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new SafeStagingError('staged attachment is not a private regular file');
  }
  return true;
};

const verifyExisting = (destination: string, expectedHash: string): boolean => {
  if (!inspectFile(destination)) {
    return false;
  }
  const actualHash = createHash('sha256').update(readFileSync(destination)).digest('hex');
  if (actualHash !== expectedHash) {
    throw new SafeStagingError('staged attachment content does not match its address');
  }
  chmodSync(destination, OWNER_ONLY_FILE_MODE);
  syncPath(destination);
  return true;
};

const auditPath = (root: string, reference: AttachmentAuditReference): null | string => {
  if (!/^[a-f0-9]{64}$/u.test(reference.contentHash)) {
    return null;
  }
  const candidate = path.resolve(reference.path);
  const expected = path.join(root, `${reference.contentHash}${MIME_EXTENSION[reference.mimeType]}`);
  return reference.path === candidate && candidate === expected ? candidate : null;
};

const privateFile = (stat: BigIntStats): boolean =>
  stat.isFile() &&
  stat.nlink === SINGLE_LINK &&
  stat.mode % FILE_MODE_MODULUS === OWNER_ONLY_FILE_MODE_BIGINT;

const audit = (root: string, reference: AttachmentAuditReference): boolean => {
  if (!Number.isSafeInteger(reference.totalBytes) || reference.totalBytes < 0) {
    return false;
  }
  const candidate = auditPath(root, reference);
  if (candidate === null || !inspectRoot(root)) {
    return false;
  }
  let descriptor: number | null = null;
  let valid = false;
  try {
    descriptor = openSync(
      candidate,
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (privateFile(before) && before.size === BigInt(reference.totalBytes)) {
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      valid =
        privateFile(after) &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        bytes.byteLength === reference.totalBytes &&
        createHash('sha256').update(bytes).digest('hex') === reference.contentHash;
    }
  } catch (error) {
    if (!['ELOOP', 'ENOENT'].includes(fileErrorCode(error) ?? '')) {
      throw error;
    }
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
  }
  return valid;
};

const persist = (
  root: string,
  bytes: Uint8Array,
  hash: string,
  extension: '.gif' | '.jpg' | '.png' | '.webp',
): string => {
  ensureRoot(root);
  const destination = directChild(root, path.join(root, `${hash}${extension}`));
  if (verifyExisting(destination, hash)) {
    return destination;
  }
  const temporary = path.join(root, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: OWNER_ONLY_FILE_MODE });
    chmodSync(temporary, OWNER_ONLY_FILE_MODE);
    syncPath(temporary);
    renameSync(temporary, destination);
    syncPath(root);
    return destination;
  } finally {
    if (lstatSync(temporary, { throwIfNoEntry: false }) !== undefined) {
      unlinkSync(temporary);
      syncPath(root);
    }
  }
};

const remove = (root: string, stagedPath: string): void => {
  const candidate = directChild(root, stagedPath);
  if (inspectRoot(root) && inspectFile(candidate)) {
    unlinkSync(candidate);
    syncPath(root);
  }
};

const sweep = (root: string, referencedPaths: readonly string[]): number => {
  ensureRoot(root);
  const referenced = new Set(referencedPaths.map((candidate) => directChild(root, candidate)));
  let removed = 0;
  for (const name of readdirSync(root)) {
    const candidate = path.join(root, name);
    const unreferencedCas = CAS_NAME.test(name) && !referenced.has(candidate);
    const stat = lstatSync(candidate, { throwIfNoEntry: false });
    const safelyRemovable = stat?.isFile() === true && !stat.isSymbolicLink() && stat.nlink === 1;
    if ((TEMPORARY_NAME.test(name) || unreferencedCas) && safelyRemovable) {
      unlinkSync(candidate);
      removed += 1;
    }
  }
  if (removed > 0) {
    syncPath(root);
  }
  return removed;
};

const makeAttachmentStore = (stagingRoot: string): AttachmentStore => {
  const root = path.resolve(stagingRoot);
  return {
    audit: (reference) => audit(root, reference),
    persist: (bytes, hash, extension) => persist(root, bytes, hash, extension),
    remove: (stagedPath) => {
      remove(root, stagedPath);
    },
    sweep: (referencedPaths) => sweep(root, referencedPaths),
  };
};

export { makeAttachmentStore };
export type { AttachmentAuditReference, AttachmentStore };
