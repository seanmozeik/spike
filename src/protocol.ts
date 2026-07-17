import { Schema } from 'effect';

import { ControlProtocolError } from './errors';

const ControlRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('status') }),
  Schema.Struct({ kind: Schema.Literal('doctor') }),
  Schema.Struct({ kind: Schema.Literal('approvals') }),
  Schema.Struct({ kind: Schema.Literal('shutdown') }),
]);
type ControlRequest = typeof ControlRequest.Type;

interface ServiceStatus {
  readonly ok: true;
}

const decodeRequest = Schema.decodeUnknownSync(ControlRequest);

const parseControlRequest = (line: string): ControlRequest => {
  try {
    return decodeRequest(JSON.parse(line));
  } catch (error) {
    throw new ControlProtocolError({ message: `invalid control request: ${String(error)}` });
  }
};

const encodeFrame = (value: unknown): string => `${JSON.stringify(value)}\n`;

export { ControlRequest, encodeFrame, parseControlRequest };
export type { ControlRequest as ControlRequestType, ServiceStatus };
