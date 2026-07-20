import { createHash } from 'node:crypto';
import { type BigIntStats, closeSync, fstatSync, readSync } from 'node:fs';
import path from 'node:path';

import {
  AttachmentStagingPermissionError,
  isFilePermissionDenied,
  SafeStagingError,
} from './errors';
import { imageFormat } from './image-format';
import type { AttachmentFailureCode, StagedAttachment } from './model';
import { openAttachmentSource } from './source-access';
import type { AttachmentStore } from './store';

const DEFAULT_MAX_ATTACHMENT_BYTES = Number('26214400');
const DEFAULT_MAX_IMAGE_PIXELS = Number('40000000');
const DEFAULT_FILE_EXTENSION = '.bin';
const SAFE_EXTENSION = /^\.[a-z0-9]{1,16}$/u;

interface AttachmentFileStagingOptions {
  readonly afterSourceStat?: (sourcePath: string) => void;
  readonly beforeSourceOpen?: (sourcePath: string) => void;
  readonly maxBytes?: number;
  readonly mimeType?: null | string;
  readonly sourceName?: null | string;
  readonly sourceRoot: string;
  readonly store: AttachmentStore;
}

type StageResult =
  | { readonly code: AttachmentFailureCode; readonly kind: 'Rejected' }
  | { readonly kind: 'Retry' }
  | ({ readonly kind: 'Staged' } & StagedAttachment & { readonly totalBytes: number });

type ReadResult = StageResult | { readonly bytes: Uint8Array; readonly kind: 'Read' };

const sameDescriptorVersion = (before: BigIntStats, after: BigIntStats): boolean =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs;

const readDescriptor = (
  descriptor: number,
  maxBytes: number,
  afterInitialStat?: () => void,
): ReadResult => {
  const before = fstatSync(descriptor, { bigint: true });
  if (!before.isFile()) {
    return { code: 'device-file', kind: 'Rejected' };
  }
  afterInitialStat?.();
  if (before.size > BigInt(maxBytes)) {
    const after = fstatSync(descriptor, { bigint: true });
    return sameDescriptorVersion(before, after)
      ? { code: 'oversize', kind: 'Rejected' }
      : { kind: 'Retry' };
  }
  const bytes = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (count === 0) {
      break;
    }
    offset += count;
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (!sameDescriptorVersion(before, after) || after.size !== BigInt(offset)) {
    return { kind: 'Retry' };
  }
  return offset > maxBytes
    ? { code: 'oversize', kind: 'Rejected' }
    : { bytes: bytes.subarray(0, offset), kind: 'Read' };
};

const readSource = (
  storedPath: string,
  maxBytes: number,
  options: AttachmentFileStagingOptions,
): ReadResult => {
  const opened = openAttachmentSource(storedPath, {
    ...(options.beforeSourceOpen === undefined
      ? {}
      : { beforeSourceOpen: options.beforeSourceOpen }),
    sourceRoot: options.sourceRoot,
  });
  if (opened.kind !== 'Opened') {
    return opened;
  }
  try {
    return readDescriptor(opened.descriptor, maxBytes, () =>
      options.afterSourceStat?.(opened.path),
    );
  } catch (error) {
    if (isFilePermissionDenied(error)) {
      throw new AttachmentStagingPermissionError({
        message:
          'Spike cannot read an attachment. Grant Full Disk Access to the Bun executable that runs spike.',
      });
    }
    throw new SafeStagingError('failed while reading an attachment');
  } finally {
    closeSync(opened.descriptor);
  }
};

const safeExtension = (sourceName: null | string | undefined): string => {
  const extension = path.extname(sourceName ?? '').toLowerCase();
  return SAFE_EXTENSION.test(extension) ? extension : DEFAULT_FILE_EXTENSION;
};

const convertedHeic = async (
  bytes: Uint8Array,
  maxBytes: number,
): Promise<Extract<StageResult, { readonly kind: 'Rejected' }> | Uint8Array> => {
  try {
    const converted = await new Bun.Image(bytes, { maxPixels: DEFAULT_MAX_IMAGE_PIXELS })
      .jpeg({ quality: 90 })
      .bytes();
    return converted.byteLength <= maxBytes ? converted : { code: 'oversize', kind: 'Rejected' };
  } catch {
    return { code: 'heic-unsupported', kind: 'Rejected' };
  }
};

const stagedAttachment = (
  bytes: Uint8Array,
  extension: string,
  mimeType: null | string,
  store: AttachmentStore,
): Extract<StageResult, { readonly kind: 'Staged' }> => {
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  return {
    contentHash,
    kind: 'Staged',
    mimeType,
    path: store.persist(bytes, contentHash, extension),
    totalBytes: bytes.byteLength,
  };
};

const stageConvertedHeic = async (
  bytes: Uint8Array,
  maxBytes: number,
  store: AttachmentStore,
): Promise<StageResult> => {
  const converted = await convertedHeic(bytes, maxBytes);
  return converted instanceof Uint8Array
    ? stagedAttachment(converted, '.jpg', 'image/jpeg', store)
    : converted;
};

const stageAttachmentFile = (
  storedPath: string,
  options: AttachmentFileStagingOptions,
): Promise<StageResult> | StageResult => {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new SafeStagingError('attachment size limit is invalid');
  }
  const read = readSource(storedPath, maxBytes, options);
  if (read.kind !== 'Read') {
    return read;
  }
  const classification = imageFormat(read.bytes);
  if (classification === 'heic') {
    return stageConvertedHeic(read.bytes, maxBytes, options.store);
  }
  const extension =
    classification === null
      ? safeExtension(options.sourceName ?? storedPath)
      : classification.extension;
  const mimeType = classification === null ? (options.mimeType ?? null) : classification.mimeType;
  return stagedAttachment(read.bytes, extension, mimeType, options.store);
};

export { stageAttachmentFile };
export type { StageResult };
