import { statSync } from 'node:fs';

const filenameText = (filename: Buffer | null | string): string | null => {
  if (filename === null) {
    return null;
  }
  return typeof filename === 'string' ? filename : filename.toString('utf8');
};

const fileIdentity = (target: string): string | null => {
  try {
    const stat = statSync(target);
    return `${String(stat.dev)}:${String(stat.ino)}`;
  } catch {
    return null;
  }
};

export { fileIdentity, filenameText };
