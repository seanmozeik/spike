import path from 'node:path';

interface AttachmentRoots {
  readonly attachmentSourceRoot: string;
  readonly attachmentStagingRoot: string;
}

const attachmentRoots = (messagesDatabase: string, stagingRoot: string): AttachmentRoots => ({
  attachmentSourceRoot: path.join(path.dirname(messagesDatabase), 'Attachments'),
  attachmentStagingRoot: stagingRoot,
});

export { attachmentRoots };
