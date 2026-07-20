import path from 'node:path';

interface AttachmentRoots {
  readonly attachmentSourceRoot: string;
  readonly attachmentStagingBoundary: string;
  readonly attachmentStagingRoot: string;
}

const attachmentRoots = (messagesDatabase: string, workingDirectory: string): AttachmentRoots => ({
  attachmentSourceRoot: path.join(path.dirname(messagesDatabase), 'Attachments'),
  attachmentStagingBoundary: workingDirectory,
  attachmentStagingRoot: path.join(workingDirectory, 'tmp', 'spike', 'attachments'),
});

export { attachmentRoots };
