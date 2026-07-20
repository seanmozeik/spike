import { Schema } from 'effect';

class ControlProtocolError extends Schema.TaggedErrorClass<ControlProtocolError>()(
  'ControlProtocolError',
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

class ControlRequestError extends Schema.TaggedErrorClass<ControlRequestError>()(
  'ControlRequestError',
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

const ControlRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('status') }),
  Schema.Struct({ kind: Schema.Literal('doctor') }),
  Schema.Struct({ kind: Schema.Literal('approvals') }),
  Schema.Struct({ kind: Schema.Literal('accounts-list') }),
  Schema.Struct({
    accountId: Schema.String,
    kind: Schema.Literal('accounts-add'),
    sourcePath: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('shutdown') }),
]);
type ControlRequest = typeof ControlRequest.Type;

const makeStructWithRest = Schema.StructWithRest;

const ControlSuccessResponse = makeStructWithRest(Schema.Struct({ ok: Schema.Literal(true) }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
type ControlSuccessResponse = typeof ControlSuccessResponse.Type;

const ControlFailureResponse = makeStructWithRest(
  Schema.Struct({ error: Schema.String, ok: Schema.Literal(false) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const ControlResponse = Schema.Union([ControlSuccessResponse, ControlFailureResponse]);

interface ServiceStatus {
  readonly ok: true;
}

const decodeRequest = Schema.decodeUnknownSync(ControlRequest);
const decodeResponse = Schema.decodeUnknownSync(ControlResponse);

const parseControlRequest = (line: string): ControlRequest => {
  try {
    return decodeRequest(JSON.parse(line));
  } catch (error) {
    throw new ControlProtocolError({
      cause: error,
      message: `invalid control request: ${String(error)}`,
      operation: 'request/decode',
    });
  }
};

const parseControlResponse = (line: string): ControlSuccessResponse => {
  let response: typeof ControlResponse.Type;
  try {
    response = decodeResponse(JSON.parse(line));
  } catch (error) {
    throw new ControlProtocolError({
      cause: error,
      message: `invalid control response: ${String(error)}`,
      operation: 'response/decode',
    });
  }
  if (!response.ok) {
    throw new ControlRequestError({
      cause: response,
      message: response.error,
      operation: 'control/request',
    });
  }
  return response;
};

const encodeFrame = (value: unknown): string => `${JSON.stringify(value)}\n`;

export {
  ControlRequest,
  ControlRequestError,
  encodeFrame,
  parseControlRequest,
  parseControlResponse,
};
export type { ControlRequest as ControlRequestType, ControlSuccessResponse, ServiceStatus };
