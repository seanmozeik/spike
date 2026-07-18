const inputBatchFingerprint = (messages: readonly { readonly id: string }[]): string =>
  JSON.stringify(messages.map(({ id }) => id));

const inputBatchText = (messages: readonly { readonly text: string }[]): string =>
  messages.map(({ text }) => text).join('\n\n');

export { inputBatchFingerprint, inputBatchText };
