import type {
  ApprovalDecision,
  ApprovalDisplay,
  ApprovalKind,
  ApprovalOption,
  ApprovalSubject,
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
  const params = isRecord(input.message.params ?? null) ? (input.message.params as Record<string, JsonValue>) : {};
  return {
    kind: approvalKind(input.message.method),
    payload: {
      kind: approvalKind(input.message.method),
      approvalRef: input.approvalRef,
      connectionId: input.connectionId,
      requestId: String(input.message.id),
      nativeMethod: input.message.method,
      request: input.message.params ?? null,
      // 与 Agent 无关的字段（ADR-0014）：界面按它们渲染，不再解析 Codex 原生字段。
      subject: approvalSubject(input.message.method),
      options: CODEX_APPROVAL_OPTIONS as unknown as JsonValue,
      display: approvalDisplay(input.message.method, params) as unknown as JsonValue,
      extensions: {
        codex: {
          nativeType: input.message.method,
        },
      },
    },
  };
}

/** Codex 的审批都支持这四种决策（批准、本会话都允许、拒绝、拒绝并中断）。 */
const CODEX_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { id: "accept", decision: "accept" },
  { id: "acceptForSession", decision: "acceptForSession" },
  { id: "decline", decision: "decline" },
  { id: "cancel", decision: "cancel" },
];

function approvalSubject(method: string): ApprovalSubject {
  const kind = approvalKind(method);
  return kind === "command" ? "command" : kind === "file-change" ? "file" : kind === "permissions" ? "permission" : "tool";
}

/** 从 Codex 原生请求里取界面要显示的内容（v2 与旧版两套字段都认）。 */
export function approvalDisplay(method: string, params: Record<string, JsonValue>): ApprovalDisplay {
  const display: ApprovalDisplay = {};
  const command = params["command"];
  if (typeof command === "string" && command !== "") {
    display.command = command;
  } else if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    display.command = (command as string[]).join(" ");
  }
  if (typeof params["cwd"] === "string" && params["cwd"] !== "") {
    display.cwd = params["cwd"];
  }
  if (typeof params["reason"] === "string" && params["reason"] !== "") {
    display.reason = params["reason"];
  }
  // 旧版补丁审批带改动文件表；v2 文件审批只带 itemId，文件列表由界面从同一条目的改动卡取。
  if (method === "applyPatchApproval" && isRecord(params["fileChanges"] ?? null)) {
    display.paths = Object.keys(params["fileChanges"] as Record<string, JsonValue>);
  }
  return display;
}

export function mapApprovalDecision(
  nativeMethod: string,
  decision: ApprovalDecision,
  requestedPermissions: JsonValue = {},
): JsonValue {
  // acceptAlways / declineAlways 是 ACP 的选项，Codex 的卡不会给出；万一传来，按最接近的语义换算。
  if (decision === "acceptAlways") {
    decision = "acceptForSession";
  } else if (decision === "declineAlways") {
    decision = "decline";
  }
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
