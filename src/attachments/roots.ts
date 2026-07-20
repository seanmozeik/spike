import path from 'node:path';

interface AttachmentRoots {
  readonly attachmentSourceRoot: string;
  readonly attachmentStagingRoot: string;
}

const attachmentRoots = (messagesDatabase: string, workingDirectory: string): AttachmentRoots => ({
  attachmentSourceRoot: path.join(path.dirname(messagesDatabase), 'Attachments'),
  attachmentStagingRoot: path.join(workingDirectory, 'tmp', 'attachments'),
});

export { attachmentRoots };
