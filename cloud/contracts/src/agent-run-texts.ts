import { plural } from "./i18n.js";
import type { AgentRunTextParams } from "./rooms.js";

/**
 * 共享 Agent 任务的原因与进度：code + 参数（中英双语技术设计 §4.3）。
 * 各人前端按自己的语言渲染；`reason` / `progress` 文字列存这里给出的英文兜底，老客户端直接显示。
 * 云端与所有者本机都从这里取兜底文字，不各写一份。
 *
 * 线上的 code 与参数类型故意放宽（`string` / `AgentRunTextParams`）：新版本加的 code 老版本照样存、照样转发，
 * 读的一方用 `readAgentRunReason` / `readAgentRunProgress` 认，认不出就显示文字列原文。
 */

type NoParams = Record<string, never>;

// ───────────────────────────── 原因 ─────────────────────────────

/** 云端写的原因（都不带参数）。 */
export const AGENT_RUN_CLOUD_REASON_CODES = [
  /** 被 @ 的 Agent 没有共享到这个房间。 */
  "not_shared",
  /** 共享了，但所有者的本机不在线。 */
  "owner_offline",
  /** 所有者关闭了共享（排队中的停掉，执行中的请求停止）。 */
  "share_closed",
  /** 共享到期。 */
  "share_expired",
  /** 执行中所有者本机太久没有心跳，判定下线、任务失败。 */
  "owner_disconnected",
  /** 所有者点了停止。 */
  "stopped_by_owner",
  /** 发起人（@ 的人）点了停止。 */
  "stopped_by_requester",
] as const;

/** 所有者本机写的原因。 */
export const AGENT_RUN_LOCAL_REASON_CODES = [
  /** 这台电脑没有为房间所属项目关联代码目录。 */
  "no_local_folder",
  /** 关联的代码目录不可用。参数 `path`。 */
  "local_folder_unavailable",
  /** 找不到触发这次任务的消息。 */
  "trigger_message_missing",
  /** 开始执行前被叫停。 */
  "stopped_before_start",
  /** 执行中被叫停。 */
  "stopped_while_running",
  /** 在所有者电脑上被中断（不是房间里的停止请求）。 */
  "interrupted_locally",
  /** 太久没有任何进展。参数 `minutes`。 */
  "stalled",
  /** 回合失败。参数四选一，见 `AgentRunReasonParamMap["turn_failed"]`。 */
  "turn_failed",
  /** 没能在本机开始执行。参数 `detail`。 */
  "local_start_failed",
  /** 执行时出错。参数 `detail`。 */
  "run_error",
  /** 远程不收回答。参数 `detail`。 */
  "reply_rejected",
  /** 本机服务重启前没执行完。 */
  "local_service_restarted",
  /** 执行完了但结果没能发回房间。 */
  "result_not_delivered",
  /** 开始执行时与需求服务的连接中断，没有执行。 */
  "start_connection_lost",
] as const;

export const AGENT_RUN_REASON_CODES = [...AGENT_RUN_CLOUD_REASON_CODES, ...AGENT_RUN_LOCAL_REASON_CODES] as const;
export type AgentRunCloudReasonCode = (typeof AGENT_RUN_CLOUD_REASON_CODES)[number];
export type AgentRunReasonCode = (typeof AGENT_RUN_REASON_CODES)[number];

/** `turn_failed` 能认出的 Codex 错误码（`codexErrorInfo` 为字符串时）。 */
export const AGENT_RUN_CODEX_ERRORS = [
  "contextWindowExceeded",
  "usageLimitExceeded",
  "unauthorized",
  "serverOverloaded",
  "internalServerError",
  "badRequest",
  "sandboxError",
  "rateLimitExceeded",
  "misalignmentPolicyViolation",
  "sessionBudgetExceeded",
  "cyberPolicy",
] as const;
export type AgentRunCodexError = (typeof AGENT_RUN_CODEX_ERRORS)[number];

/** `turn_failed` 认不出错误码时，按状态码与报错原文归的类。 */
export const AGENT_RUN_FAILURE_CATEGORIES = ["rate_limited", "unauthorized", "forbidden", "server_error", "timeout"] as const;
export type AgentRunFailureCategory = (typeof AGENT_RUN_FAILURE_CATEGORIES)[number];

/** 带参数的原因各自的参数；没列出的 code 不带参数。参数里的原文是所有者本机界面语言的文字，原样显示。 */
export interface AgentRunReasonParamMap {
  local_folder_unavailable: { path: string };
  stalled: { minutes: number };
  local_start_failed: { detail: string };
  run_error: { detail: string };
  reply_rejected: { detail: string };
  /** Codex 错误码 / 按状态码归类 / 报错原文（≤ 500 字）/ 都没有（原因未知，空对象）。 */
  turn_failed: { codexError: AgentRunCodexError } | { category: AgentRunFailureCategory } | { detail: string } | NoParams;
}

export type AgentRunReasonParams<C extends AgentRunReasonCode> = C extends keyof AgentRunReasonParamMap
  ? AgentRunReasonParamMap[C]
  : NoParams;

/** 一条认出来的原因：code 与对应形状的参数。 */
export type AgentRunReason = { [C in AgentRunReasonCode]: { code: C; params: AgentRunReasonParams<C> } }[AgentRunReasonCode];

const REASON_CODES = new Set<string>(AGENT_RUN_REASON_CODES);
const CODEX_ERRORS = new Set<string>(AGENT_RUN_CODEX_ERRORS);
const FAILURE_CATEGORIES = new Set<string>(AGENT_RUN_FAILURE_CATEGORIES);

function isReasonCode(value: string | null | undefined): value is AgentRunReasonCode {
  return value !== null && value !== undefined && REASON_CODES.has(value);
}

function isCodexError(value: unknown): value is AgentRunCodexError {
  return typeof value === "string" && CODEX_ERRORS.has(value);
}

function isFailureCategory(value: unknown): value is AgentRunFailureCategory {
  return typeof value === "string" && FAILURE_CATEGORIES.has(value);
}

/**
 * 读线上的原因：code 认不出、或参数缺了 / 类型不对 / 取值认不出时返回 null，由调用方显示 `reason` 原文。
 * 多出来的参数忽略。
 */
export function readAgentRunReason(
  code: string | null | undefined,
  params: AgentRunTextParams | null | undefined,
): AgentRunReason | null {
  if (!isReasonCode(code)) return null;
  const values: AgentRunTextParams = params ?? {};
  switch (code) {
    case "local_folder_unavailable": {
      const path = values["path"];
      return typeof path === "string" ? { code, params: { path } } : null;
    }
    case "stalled": {
      const minutes = values["minutes"];
      return typeof minutes === "number" && Number.isFinite(minutes) ? { code, params: { minutes } } : null;
    }
    case "local_start_failed":
    case "run_error":
    case "reply_rejected": {
      const detail = values["detail"];
      return typeof detail === "string" ? { code, params: { detail } } : null;
    }
    case "turn_failed": {
      const codexError = values["codexError"];
      const category = values["category"];
      const detail = values["detail"];
      if (codexError !== undefined) return isCodexError(codexError) ? { code, params: { codexError } } : null;
      if (category !== undefined) return isFailureCategory(category) ? { code, params: { category } } : null;
      if (detail !== undefined) return typeof detail === "string" ? { code, params: { detail } } : null;
      return { code, params: {} };
    }
    default:
      return { code, params: {} };
  }
}

const CODEX_ERROR_EN: Record<AgentRunCodexError, string> = {
  contextWindowExceeded:
    "This conversation is past the model's context window. @ the agent again in a new thread, or ask the owner to look into it.",
  usageLimitExceeded: "The owner has reached their model usage limit. Try again later.",
  unauthorized:
    "The model service on the owner's computer rejected the credentials (401). The owner needs to check the model service settings.",
  serverOverloaded: "The model service is busy right now. Wait a moment, then retry.",
  internalServerError: "The model service had a temporary error. Retry later.",
  badRequest: "The model service rejected this request. A parameter or attachment may not be supported.",
  sandboxError: "A command couldn't run in the read-only sandbox.",
  rateLimitExceeded: "The model service is limiting requests. Wait a few minutes, then retry.",
  misalignmentPolicyViolation:
    "This request triggered the model service's safety policy and was stopped. Try rephrasing it.",
  sessionBudgetExceeded: "This thread has used up its usage budget. @ the agent again in a new thread.",
  cyberPolicy: "The request involves cybersecurity content and was blocked by the model service's safety policy.",
};

const FAILURE_CATEGORY_EN: Record<AgentRunFailureCategory, string> = {
  rate_limited: "The model service is limiting requests (429). Wait a few minutes, then retry.",
  unauthorized: CODEX_ERROR_EN.unauthorized,
  forbidden: "The model service refused the request (403). The owner's credentials may not have access to this model.",
  server_error: CODEX_ERROR_EN.internalServerError,
  timeout: "The model service timed out. Retry later.",
};

function englishReason(reason: AgentRunReason): string {
  switch (reason.code) {
    case "not_shared":
      return "Not shared to this room";
    case "owner_offline":
      return "The owner is offline";
    case "share_closed":
      return "Sharing was turned off";
    case "share_expired":
      return "Sharing expired";
    case "owner_disconnected":
      return "The owner's computer went offline, so the run was interrupted";
    case "stopped_by_owner":
      return "Stopped by the owner";
    case "stopped_by_requester":
      return "Stopped by the person who asked";
    case "no_local_folder":
      return "The owner's computer has no local folder linked to this project";
    case "local_folder_unavailable":
      return `The local folder linked to this project on the owner's computer isn't available (${reason.params.path}). The owner needs to link it again.`;
    case "trigger_message_missing":
      return "Couldn't find the message that started this task";
    case "stopped_before_start":
      return "Stopped before it started";
    case "stopped_while_running":
      return "Stopped while running";
    case "interrupted_locally":
      return "Interrupted on the owner's computer";
    case "stalled": {
      const minutes = reason.params.minutes;
      return `Run interrupted: no progress for ${plural("en", minutes, { one: "1 minute", other: `${String(minutes)} minutes` })}`;
    }
    case "turn_failed": {
      const params = reason.params;
      if ("codexError" in params) return CODEX_ERROR_EN[params.codexError];
      if ("category" in params) return FAILURE_CATEGORY_EN[params.category];
      if ("detail" in params) return `The run failed: ${params.detail}`;
      return "The run failed for an unknown reason.";
    }
    case "local_start_failed":
      return `Couldn't start running on the owner's computer: ${reason.params.detail}`;
    case "run_error":
      return `The run failed: ${reason.params.detail}`;
    case "reply_rejected":
      return `Couldn't post the answer to the room: ${reason.params.detail}`;
    case "local_service_restarted":
      return "Run interrupted (the owner's local service restarted)";
    case "result_not_delivered":
      return "The result couldn't be sent back to the room. See the room task session on the owner's computer.";
    case "start_connection_lost":
      return "Lost the connection to the requirements service while starting, so this didn't run. You can retry.";
  }
}

/** 原因的英文兜底（写 `reason` 文字列用）。 */
export function agentRunReasonFallback<C extends AgentRunReasonCode>(code: C, params: AgentRunReasonParams<C>): string {
  return englishReason({ code, params } as AgentRunReason);
}

// ───────────────────────────── 进度 ─────────────────────────────

export const AGENT_RUN_PROGRESS_CODES = [
  /** 还没有任何步骤。 */
  "thinking",
  /** 按步骤种类计数，参数见 `AgentRunActivityCounts`。 */
  "activity",
] as const;
export type AgentRunProgressCode = (typeof AGENT_RUN_PROGRESS_CODES)[number];

/** 进度里计数的步骤种类；顺序即显示顺序，与会话时间线的步骤组摘要同口径。 */
export const AGENT_RUN_ACTIVITY_KINDS = ["read", "search", "list", "command", "tool", "web"] as const;
export type AgentRunActivityKind = (typeof AGENT_RUN_ACTIVITY_KINDS)[number];

/** 各种步骤的次数：查看的文件、搜索、列出的目录、运行的命令、工具调用、网页搜索。只放大于 0 的。 */
export type AgentRunActivityCounts = Partial<Record<AgentRunActivityKind, number>>;

export interface AgentRunProgressParamMap {
  thinking: NoParams;
  activity: AgentRunActivityCounts;
}

export type AgentRunProgress = { [C in AgentRunProgressCode]: { code: C; params: AgentRunProgressParamMap[C] } }[AgentRunProgressCode];

/** 读线上的进度：code 认不出、或 activity 没有一项有效计数时返回 null，由调用方显示 `progress` 原文。多出来的参数忽略。 */
export function readAgentRunProgress(
  code: string | null | undefined,
  params: AgentRunTextParams | null | undefined,
): AgentRunProgress | null {
  if (code === "thinking") return { code, params: {} };
  if (code !== "activity") return null;
  const counts: AgentRunActivityCounts = {};
  for (const kind of AGENT_RUN_ACTIVITY_KINDS) {
    const count = params?.[kind];
    if (typeof count === "number" && Number.isInteger(count) && count > 0) counts[kind] = count;
  }
  return Object.keys(counts).length === 0 ? null : { code, params: counts };
}

const ACTIVITY_EN: Record<AgentRunActivityKind, (count: number) => string> = {
  read: (count) => plural("en", count, { one: "Read 1 file", other: `Read ${String(count)} files` }),
  search: (count) => plural("en", count, { one: "Searched once", other: `Searched ${String(count)} times` }),
  list: (count) => plural("en", count, { one: "Listed 1 folder", other: `Listed ${String(count)} folders` }),
  command: (count) => plural("en", count, { one: "Ran 1 command", other: `Ran ${String(count)} commands` }),
  tool: (count) => plural("en", count, { one: "Made 1 tool call", other: `Made ${String(count)} tool calls` }),
  web: (count) => plural("en", count, { one: "Searched the web once", other: `Searched the web ${String(count)} times` }),
};

/** 进度的英文兜底（写 `progress` 文字列用）：「Read 6 files · Ran 2 commands」，没有步骤时「Thinking」。 */
export function agentRunProgressFallback<C extends AgentRunProgressCode>(code: C, params: AgentRunProgressParamMap[C]): string {
  const progress = { code, params } as AgentRunProgress;
  if (progress.code === "thinking") return "Thinking";
  const parts = AGENT_RUN_ACTIVITY_KINDS.flatMap((kind) => {
    const count = progress.params[kind];
    return count === undefined || count <= 0 ? [] : [ACTIVITY_EN[kind](count)];
  });
  return parts.length === 0 ? "Thinking" : parts.join(" · ");
}

// ───────────────────────────── 执行过程 ─────────────────────────────

/** 执行过程太长、中间被省略时，末尾补的那条 `runtime.warning` 的 code；`params: { omitted }` 是省略的条数。 */
export const AGENT_RUN_EVENTS_TRUNCATED_CODE = "room-run-events-truncated";

/** 上面那条说明的英文兜底（写 `payload.message` 用）。 */
export function agentRunEventsTruncatedFallback(omitted: number): string {
  const leftOut = plural("en", omitted, {
    one: "1 record in the middle was left out",
    other: `${String(omitted)} records in the middle were left out`,
  });
  return `The run details were too long, so ${leftOut} (the beginning and end are kept). The full details are in the room task session on the owner's computer.`;
}
