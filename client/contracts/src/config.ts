import type { RuntimeSecurityPolicy } from "./runtime.js";

export const CODEX_VERSION = "0.159.2" as const;
export const DEFAULT_CODEX_RUNTIME_ID = "codex-local" as const;
export const DEFAULT_CODEX_TRANSPORT = "stdio" as const;

export const M1_RUNTIME_SECURITY_POLICY = {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: {
    mode: "read-only",
    networkAccess: false,
  },
} as const satisfies RuntimeSecurityPolicy;

/** 会话级审批模式（对齐 codex 三档）。 */
export type ApprovalMode = "ask" | "auto" | "full";

export const APPROVAL_MODE_POLICIES: Record<ApprovalMode, RuntimeSecurityPolicy> = {
  /** 每步询问：只读沙箱，任何写/执行都需批准（M1 原策略）。 */
  ask: M1_RUNTIME_SECURITY_POLICY,
  /** 替我审批：项目目录内可写可执行，越界（项目外写、联网、危险命令）才询问。 */
  auto: {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { mode: "workspace-write", networkAccess: false },
  },
  /** 完全访问：不设限、不询问。 */
  full: {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { mode: "danger-full-access", networkAccess: true },
  },
};

/**
 * 房间共享 Agent（ADR-0009）：只读沙箱、可联网查资料、不弹审批（没人在所有者电脑前审批）。
 * 只用于房间任务会话，不是用户可选的审批模式。
 */
export const ROOM_AGENT_SECURITY_POLICY = {
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: { mode: "read-only", networkAccess: true },
} as const satisfies RuntimeSecurityPolicy;

/**
 * Codex 内置认识的推理强度（界面文案与排序用）。协议里 `ReasoningEffort` 是「模型声明的非空字符串」，
 * 某个模型支持哪几档以 model/list 的 `supportedReasoningEfforts` 为准；模型新声明的档位只要格式合法也接受，
 * 不因这里没列而拒绝。
 */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type KnownReasoningEffort = (typeof REASONING_EFFORTS)[number];
/** 开放字符串：小写字母开头，只含小写字母、数字、`_`、`-`，最长 32 位。 */
export type ReasoningEffort = string;

const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_PATTERN.test(value);
}

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  ask: "每步询问",
  auto: "替我审批",
  full: "完全访问",
};

export const SUDUO_DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  codexBin: "codex",
  codexVersion: CODEX_VERSION,
  codexTransport: DEFAULT_CODEX_TRANSPORT,
  sseHeartbeatMs: 15_000,
  sseReplayPageSize: 500,
  runtimeRestartMaxMs: 30_000,
  logLevel: "info",
} as const;

export type SuDuoDefaults = typeof SUDUO_DEFAULTS;
