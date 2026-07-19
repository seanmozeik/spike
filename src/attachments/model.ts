interface StagedImageAttachment {
  readonly contentHash: string;
  readonly mimeType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  readonly path: string;
}

type AttachmentFailureCode =
  | 'device-file'
  | 'heic-unsupported'
  | 'legacy-claimed'
  | 'missing-source'
  | 'outside-messages-root'
  | 'oversize'
  | 'staged-integrity'
  | 'symlink'
  | 'unsupported-type';

export type { AttachmentFailureCode, StagedImageAttachment };
