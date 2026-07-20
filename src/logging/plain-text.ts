interface LogTailOptions {
  readonly maxLines: number;
  readonly startsMidLine: boolean;
}

const plainLogText = (text: string): string => Bun.stripANSI(text);

const formatLogTail = (contents: string, options: LogTailOptions): string => {
  const normalized = plainLogText(contents).trimEnd();
  if (normalized === '') {
    return '';
  }
  const lines = normalized.split('\n');
  if (options.startsMidLine) {
    lines.shift();
  }
  return lines.slice(-options.maxLines).join('\n');
};

export { formatLogTail, plainLogText };
export type { LogTailOptions };
