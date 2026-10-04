import type {
  ApprovalDecision,
  ApprovalKind,
  JsonRpcId,
  JsonValue,
  RpcInbound,
  ThreadRef,
} from "@suduo/client-contracts";

export interface PendingNativeApproval {
  approvalRef: string;
  connectionId: string;
  requestId: JsonRpcId;
  nativeMethod: string;
  threadRef: ThreadRef;
  /** item/permissions/requestApproval 请求的权限（同意时原样授予）。 */
  requestedPermissions?: JsonValue;
}

export interface NormalizedApprovalRequest {
  kind: ApprovalKind;
  payload: JsonValue;
}

type ServerRequest = Extract<RpcInbound, { kind: "server-request" }>;
type ApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval"
  | "execCommandApproval"
  | "applyPatchApproval";

export type ApprovalServerRequest = ServerRequest & {
  method: ApprovalMethod;
};

export function isApprovalServerRequest(
  message: RpcInbound,
): message is ApprovalServerRequest {
  return (
    message.kind === "server-request" &&
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "execCommandApproval",
      "applyPatchApproval",
    ].includes(message.method)
  );
}

export function normalizeApprovalRequest(input: {
  message: ApprovalServerRequest;
  approvalRef: string;
  connectionId: string;
}): NormalizedApprovalRequest {
  return {
    kind: approvalKind(input.message.method),
    payload: {
      kind: approvalKind(input.message.method),
      approvalRef: input.approvalRef,
      connectionId: input.connectionId,
      requestId: String(input.message.id),
      nativeMethod: input.message.method,
      request: input.message.params ?? null,
      extensions: {
        codex: {
          nativeType: input.message.method,
        },
      },
    },
  };
}

export function mapApprovalDecision(
  nativeMethod: string,
  decision: ApprovalDecision,
  requestedPermissions: JsonValue = {},
): JsonValue {
  if (
    nativeMethod === "item/commandExecution/requestApproval" ||
    nativeMethod === "item/fileChange/requestApproval"
  ) {
    return {
      decision,
    };
  }
  if (
    nativeMethod === "execCommandApproval" ||
    nativeMethod === "applyPatchApproval"
  ) {
    // ReviewDecision：拒绝是 { denied: { rejection } }（字符串 "denied" 在新版里不合法）；中断本回合是 abort。
    // 拒绝原因回给 Codex：这一层只认线程、拿不到会话语言，固定写英文。
    return {
      decision:
        decision === "accept"
          ? "approved"
          : decision === "acceptForSession"
            ? "approved_for_session"
            : decision === "cancel"
              ? "abort"
              : { denied: { rejection: "The user declined this action." } },
    };
  }
  if (nativeMethod === "item/permissions/requestApproval") {
    // permissions 必须是 GrantedPermissionProfile 对象：批准只授予这一回合，「本会话都允许」授予整个会话，
    // 拒绝 / 中断则什么都不授予。
    if (decision === "accept" || decision === "acceptForSession") {
      return {
        permissions: isRecord(requestedPermissions) ? requestedPermissions : {},
        scope: decision === "acceptForSession" ? "session" : "turn",
      };
    }
    return {
      permissions: {},
      scope: "turn",
    };
  }
  throw new Error("unsupported Codex approval method: " + nativeMethod);
}

function approvalKind(method: string): ApprovalKind {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "execCommandApproval"
  ) {
    return "command";
  }
  if (
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval"
  ) {
    return "file-change";
  }
  if (method === "item/permissions/requestApproval") {
    return "permissions";
  }
  return "other";
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
