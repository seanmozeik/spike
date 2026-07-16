const markdownLink =
  /!?\[(?<label>[^\]]*)\]\((?<url>https?:\/\/[^)\s]+)(?:\s+["'][^"']*["'])?\)/giu;
const autolink = /<(?<url>https?:\/\/[^>\s]+)>/giu;
const fencedCodeMarker = /^\s*(?<marker>`{3,}|~{3,})(?:\S.*)?$/u;
const headingMarker = /^\s{0,3}#{1,6}\s+/u;
const listMarker = /^\s*(?:[-+*]|\d+[.)])\s+/u;
const blockquoteMarker = /^\s*>\s?/u;
const tableDivider = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/u;
const thematicBreak = /^\s{0,3}(?:(?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})$/u;

const flattenTableRow = (line: string): string => {
  if (!line.includes('|')) {
    return line;
  }
  const cells = line
    .replace(/^\s*\|/u, '')
    .replace(/\|\s*$/u, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
  return cells.length > 1 ? cells.join('; ') : line;
};

const stripInlineMarkdown = (text: string): string =>
  text
    .replace(markdownLink, (_match, label: string, url: string) =>
      label.trim().length === 0 || label.trim() === url ? url : `${label.trim()}: ${url}`,
    )
    .replace(autolink, '$<url>')
    .replaceAll(/(?<ticks>`+)(?<content>.*?)\k<ticks>/gu, '$<content>')
    .replaceAll(/(?<marker>\*\*|__|~~)(?<content>.*?)\k<marker>/gu, '$<content>')
    .replaceAll(
      /(?<prefix>^|[\s([{])(?<marker>[*_])(?=\S)(?<content>.*?\S)\k<marker>(?=$|[\s)\]},.!?:;])/gu,
      '$<prefix>$<content>',
    );

const stripTerminalFullStop = (text: string): string =>
  text.replace(/(?<!\.)\.(?<space>\s*)$/u, '$<space>');

const applyPlainTextFallback = (text: string): string => {
  let insideFence = false;
  const lines: string[] = [];
  for (const originalLine of text.replaceAll(/[—–]/gu, ', ').split('\n')) {
    if (fencedCodeMarker.test(originalLine)) {
      insideFence = !insideFence;
    } else if (!tableDivider.test(originalLine) && !thematicBreak.test(originalLine)) {
      const withoutBlockSyntax = insideFence
        ? originalLine
        : originalLine
            .replace(headingMarker, '')
            .replace(listMarker, '')
            .replace(blockquoteMarker, '');
      lines.push(stripInlineMarkdown(flattenTableRow(withoutBlockSyntax)));
    }
  }
  return stripTerminalFullStop(lines.join('\n').replaceAll(/\n{3,}/gu, '\n\n'));
};

export { applyPlainTextFallback };
