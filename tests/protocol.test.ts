import { describe, expect, it } from 'vitest';

import { encodeFrame, parseControlRequest } from '../src/protocol';

describe('control protocol', () => {
  it('decodes the closed request union', () => {
    expect(parseControlRequest('{"kind":"status"}')).toStrictEqual({ kind: 'status' });
    expect(parseControlRequest('{"kind":"doctor"}')).toStrictEqual({ kind: 'doctor' });
    expect(parseControlRequest('{"kind":"shutdown"}')).toStrictEqual({ kind: 'shutdown' });
    expect(() => parseControlRequest('{"kind":"unknown"}')).toThrow('invalid control request');
  });

  it('uses one JSON frame per line', () => {
    expect(encodeFrame({ ok: true })).toBe('{"ok":true}\n');
  });
});
