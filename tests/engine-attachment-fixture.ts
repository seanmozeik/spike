import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { SpikeEngineOptions } from '../src/service/engine';

const FIXTURE_JPEG = Buffer.from('FFD8FFD9', 'hex');

const prepareAttachmentOptions = (
  root: string,
): Pick<SpikeEngineOptions, 'attachmentSourceRoot' | 'attachmentStagingRoot'> => {
  const attachmentSourceRoot = path.join(root, 'Attachments');
  mkdirSync(attachmentSourceRoot, { recursive: true });
  writeFileSync(path.join(attachmentSourceRoot, 'photo.jpg'), FIXTURE_JPEG);
  return { attachmentSourceRoot, attachmentStagingRoot: path.join(root, 'staged-attachments') };
};

export { prepareAttachmentOptions };
