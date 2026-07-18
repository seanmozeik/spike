import { Schema } from 'effect';

const ApprovalMethod = Schema.Literals([
  'applyPatchApproval',
  'execCommandApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

const CurrentBase = {
  itemId: Schema.String,
  startedAtMs: Schema.Finite,
  threadId: Schema.String,
  turnId: Schema.String,
} as const;

const NullableUnknownArray = Schema.NullOr(Schema.Array(Schema.Unknown));
const CommandApprovalParams = Schema.Struct({
  ...CurrentBase,
  additionalPermissions: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
  approvalId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  availableDecisions: Schema.optionalKey(NullableUnknownArray),
  command: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const FileChangeApprovalParams = Schema.Struct({
  ...CurrentBase,
  grantRoot: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const PermissionProfile = Schema.Struct({
  fileSystem: Schema.NullOr(Schema.Unknown),
  network: Schema.NullOr(Schema.Unknown),
});

const PermissionsApprovalParams = Schema.Struct({
  ...CurrentBase,
  cwd: Schema.String,
  permissions: PermissionProfile,
  reason: Schema.NullOr(Schema.String),
});

const LegacyExecApprovalParams = Schema.Struct({
  approvalId: Schema.NullOr(Schema.String),
  callId: Schema.String,
  command: Schema.Array(Schema.String),
  conversationId: Schema.String,
  cwd: Schema.String,
  reason: Schema.NullOr(Schema.String),
});

const LegacyPatchApprovalParams = Schema.Struct({
  callId: Schema.String,
  conversationId: Schema.String,
  fileChanges: Schema.Record(Schema.String, Schema.Unknown),
  grantRoot: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
});

export {
  ApprovalMethod,
  CommandApprovalParams,
  FileChangeApprovalParams,
  LegacyExecApprovalParams,
  LegacyPatchApprovalParams,
  PermissionsApprovalParams,
};
