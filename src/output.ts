const JSON_INDENT = 2;

export type OutputMode = 'human' | 'json' | 'agent';

export const writeStructured = (mode: OutputMode, value: unknown): void => {
  console.log(JSON.stringify(value, null, mode === 'agent' ? undefined : JSON_INDENT));
};

export const failPayload = (
  message: string,
): { readonly ok: false; readonly code: 'error'; readonly message: string } => ({
  code: 'error',
  message,
  ok: false,
});
