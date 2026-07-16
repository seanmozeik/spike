const FINAL_CHUNK_LIMIT = 10_000;
const HIGH_SURROGATE_START = '\uD800';
const HIGH_SURROGATE_END = '\uDBFF';
const LOW_SURROGATE_START = '\uDC00';
const LOW_SURROGATE_END = '\uDFFF';

const avoidSurrogateSplit = (text: string, cut: number): number => {
  const before = text.slice(cut - 1, cut);
  const after = text.slice(cut, cut + 1);
  const splitsPair =
    before >= HIGH_SURROGATE_START &&
    before <= HIGH_SURROGATE_END &&
    after >= LOW_SURROGATE_START &&
    after <= LOW_SURROGATE_END;
  return splitsPair ? cut - 1 : cut;
};

const splitPoint = (text: string, limit: number): number => {
  const paragraph = text.lastIndexOf('\n\n', limit);
  if (paragraph > 0) {
    return paragraph;
  }
  const line = text.lastIndexOf('\n', limit);
  if (line > 0) {
    return line;
  }
  const word = text.lastIndexOf(' ', limit);
  return word > 0 ? word : avoidSurrogateSplit(text, limit);
};

const chunkFinalAnswer = (text: string, limit = FINAL_CHUNK_LIMIT): readonly string[] => {
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const cut = splitPoint(remaining, limit);
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^(?:\n+| )/u, '');
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
};

export { chunkFinalAnswer, FINAL_CHUNK_LIMIT };
