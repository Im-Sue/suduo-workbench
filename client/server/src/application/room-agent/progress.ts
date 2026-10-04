import {
  BACKFILL_OMITTED_EVENT_TYPES,
  BACKFILL_LATEST_ONLY_EVENT_TYPES,
  type EventEnvelope,
  type JsonValue,
} from "@suduo/client-contracts";
import {
  AGENT_RUN_ACTIVITY_KINDS,
  AGENT_RUN_CODEX_ERRORS,
  AGENT_RUN_EVENTS_TRUNCATED_CODE,
  agentRunEventsTruncatedFallback,
  type AgentRunActivityCounts,
  type AgentRunActivityKind,
  type AgentRunCodexError,
  type AgentRunProgress,
  type AgentRunReason,
} from "@suduo/cloud-contracts";
import type { ServerMessages } from "../../i18n/messages/index.js";

/**
 * 房间任务的执行过程：进度（code + 计数，与前端时间线同口径）、回写给远程的事件（截断）、失败原因归类。
 * 进度与原因只给 code 与参数（中英双语技术设计 §4.3），各人前端按自己的语言渲染；文字兜底见 cloud-contracts。
 */

/** 按本回合的 item 统计进度：各种步骤的次数（前端说成「查看了 6 个文件 · 运行了 2 条命令」），没有步骤时 thinking。 */
export class RunProgressTracker {
  private readonly steps = new Map<string, AgentRunActivityKind>();

  observe(event: { type: string; payload: JsonValue }): void {
    if (event.type !== "item.started" && event.type !== "item.completed") {
      return;
    }
    const item = objectOf(objectOf(event.payload)["item"]);
    const id = typeof item["id"] === "string" ? item["id"] : null;
    const kind = classifyItem(item);
    if (id === null || kind === null) {
      return;
    }
    this.steps.set(id, kind);
  }

  progress(): AgentRunProgress {
    const counts: AgentRunActivityCounts = {};
    for (const kind of AGENT_RUN_ACTIVITY_KINDS) {
      let count = 0;
      for (const step of this.steps.values()) {
        if (step === kind) count += 1;
      }
      if (count > 0) counts[kind] = count;
    }
    return Object.keys(counts).length === 0 ? { code: "thinking", params: {} } : { code: "activity", params: counts };
  }
}

function classifyItem(item: Record<string, JsonValue>): AgentRunActivityKind | null {
  switch (item["type"]) {
    case "commandExecution": {
      const actions = Array.isArray(item["commandActions"]) ? item["commandActions"].map(objectOf) : [];
      const kinds = new Set(actions.map((action) => String(action["type"] ?? "unknown")));
      if (actions.length > 0 && kinds.size === 1) {
        if (kinds.has("read")) return "read";
        if (kinds.has("search")) return "search";
        if (kinds.has("listFiles")) return "list";
      }
      return "command";
    }
    case "imageView":
      return "read";
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "subAgentActivity":
      return "tool";
    case "webSearch":
      return "web";
    default:
      return null;
  }
}

// ───────────────────────────── 执行过程回写 ─────────────────────────────

export const RUN_EVENT_LIMITS = {
  /** 单条事件里任一长文本的上限。 */
  stringChars: 4_000,
  /** 整段过程（JSON 字节）的上限。 */
  totalBytes: 1_500_000,
};

const OMITTED = new Set<string>(BACKFILL_OMITTED_EVENT_TYPES);
const LATEST_ONLY = new Set<string>(BACKFILL_LATEST_ONLY_EVENT_TYPES);

/**
 * 这一回合在本机账本里的事件 → 回写给远程的 `EventEnvelope[]`（技术设计 4.2「执行过程上传」）：
 * - 和历史回放同口径去掉逐字增量（item.completed 里有完整内容），快照类只留最后一条；
 * - 去掉 `extensions`（Codex 原生参数副本，顶层已平铺同样的字段）；
 * - 单条里的长文本截到 4000 字，后缀按所有者的界面语言（`t`）写；
 * - 整段超过 1.5MB 时丢中间、保留开头与结尾，并在末尾加一条说明（`runtime.warning`，带 code 与 `params.omitted`，
 *   message 是英文兜底，前端按 code 渲染）。
 * 只为控制体积，不是脱敏（需求「执行过程对房间完整可见」）。
 */
export function compactRunEvents(
  events: ReadonlyArray<EventEnvelope<string, JsonValue>>,
  t: ServerMessages,
  limits: { stringChars: number; totalBytes: number } = RUN_EVENT_LIMITS,
): Array<EventEnvelope<string, JsonValue>> {
  const lastSnapshot = new Map<string, number>();
  for (const event of events) {
    if (LATEST_ONLY.has(event.type)) lastSnapshot.set(event.type, event.seq);
  }
  const compacted = events
    .filter((event) => !OMITTED.has(event.type))
    .filter((event) => !LATEST_ONLY.has(event.type) || lastSnapshot.get(event.type) === event.seq)
    .map((event) => ({
      schemaVersion: 1 as const,
      seq: event.seq,
      eventId: event.eventId,
      sessionId: event.sessionId,
      source: event.source,
      type: event.type,
      payload: clipStrings(stripExtensions(event.payload), limits.stringChars, t),
      threadRef: event.threadRef,
      turnRef: event.turnRef,
      ts: event.ts,
    }));
  const sizes = compacted.map((event) => Buffer.byteLength(JSON.stringify(event)));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= limits.totalBytes || compacted.length === 0) {
    return compacted;
  }
  const last = compacted.at(-1)!;
  const notice = (omitted: number): EventEnvelope<string, JsonValue> => ({
    schemaVersion: 1,
    seq: last.seq + 1,
    eventId: `room-run-truncated-${last.eventId}`,
    sessionId: last.sessionId,
    source: "suduo:room-agent",
    type: "runtime.warning",
    payload: {
      code: AGENT_RUN_EVENTS_TRUNCATED_CODE,
      params: { omitted },
      message: agentRunEventsTruncatedFallback(omitted),
    },
    threadRef: last.threadRef,
    turnRef: last.turnRef,
    ts: last.ts,
  });
  const budget = limits.totalBytes - Buffer.byteLength(JSON.stringify(notice(compacted.length)));
  const headBudget = Math.floor(budget / 2);
  let headEnd = 0;
  let used = 0;
  while (headEnd < compacted.length && used + sizes[headEnd]! <= headBudget) {
    used += sizes[headEnd]!;
    headEnd += 1;
  }
  let tailStart = compacted.length;
  while (tailStart > headEnd && used + sizes[tailStart - 1]! <= budget) {
    used += sizes[tailStart - 1]!;
    tailStart -= 1;
  }
  const omitted = tailStart - headEnd;
  return [...compacted.slice(0, headEnd), ...compacted.slice(tailStart), notice(omitted)];
}

function stripExtensions(payload: JsonValue): JsonValue {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload) || !("extensions" in payload)) {
    return payload;
  }
  const { extensions, ...rest } = payload;
  void extensions;
  return rest;
}

function clipStrings(value: JsonValue, limit: number, t: ServerMessages): JsonValue {
  if (typeof value === "string") {
    const text = withoutNul(value);
    return text.length > limit ? text.slice(0, limit) + t.room.clipped(text.length) : text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => clipStrings(item, limit, t));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[withoutNul(key)] = clipStrings(item, limit, t);
    }
    return result;
  }
  return value;
}

/**
 * 去掉 NUL（`\u0000`）：PostgreSQL 的 jsonb / text 都拒收，带上它远程会稳定回 500、重试必败
 * （命令输出里 cat 一个二进制文件就会有）。回答、原因、进度、执行过程上传前都要过一遍。
 */
export function withoutNul(text: string): string {
  return text.includes("\u0000") ? text.replaceAll("\u0000", "") : text;
}

// ───────────────────────────── 失败原因 ─────────────────────────────

const CODEX_ERRORS = new Set<string>(AGENT_RUN_CODEX_ERRORS);

function isCodexError(value: JsonValue | undefined): value is AgentRunCodexError {
  return typeof value === "string" && CODEX_ERRORS.has(value);
}

/**
 * 回合失败的原因（给房间里的人看，前端按 code 渲染）：认得出的 Codex 错误码直接给码；
 * 否则按状态码与报错原文归类（限流 / 认证 / 无权限 / 服务出错 / 超时）；都不像就给报错原文（≤ 500 字），
 * 什么都没有时只给 code（原因未知）。归类口径与前端 `event-projection/shared.ts` 的 Codex 错误说明一致。
 */
export function describeTurnFailure(payload: JsonValue): Extract<AgentRunReason, { code: "turn_failed" }> {
  const turn = objectOf(objectOf(payload)["turn"]);
  const error = objectOf(turn["error"] ?? objectOf(payload)["error"]);
  const info = error["codexErrorInfo"];
  if (isCodexError(info)) {
    return { code: "turn_failed", params: { codexError: info } };
  }
  let status: number | null = null;
  if (info !== null && typeof info === "object" && !Array.isArray(info)) {
    for (const value of Object.values(info)) {
      const record = objectOf(value);
      if (typeof record["httpStatusCode"] === "number") status = record["httpStatusCode"];
    }
  }
  const message = typeof error["message"] === "string" ? error["message"] : "";
  const details = typeof error["additionalDetails"] === "string" ? error["additionalDetails"] : "";
  const text = `${status === null ? "" : String(status)} ${details} ${message}`.trim();
  const failed = (params: Extract<AgentRunReason, { code: "turn_failed" }>["params"]) => ({ code: "turn_failed" as const, params });
  if (/429|too many requests/iu.test(text)) return failed({ category: "rate_limited" });
  if (/401|unauthorized|authentication/iu.test(text)) return failed({ category: "unauthorized" });
  if (/403|forbidden/iu.test(text)) return failed({ category: "forbidden" });
  if (/5\d\d|internal server error|bad gateway|service unavailable/iu.test(text)) return failed({ category: "server_error" });
  if (/timeout|timed out/iu.test(text)) return failed({ category: "timeout" });
  return text === "" ? failed({}) : failed({ detail: text.slice(0, 500) });
}

/** 回答的第一句（≤ 80 字）作摘要：跳过标题行与列表符号。 */
export function summaryOf(reply: string): string {
  const lines = reply
    .replace(/```[\s\S]*?```/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const contentLines = lines.filter((line) => !/^#{1,6}\s/u.test(line));
  const first = (contentLines[0] ?? lines[0] ?? "")
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^(?:[-*+>]|\d+[.)])\s+/u, "")
    .replace(/\*\*|__|`/gu, "")
    .trim();
  const sentence = /^(.+?[。！？!?；;])/u.exec(first)?.[1] ?? first;
  const characters = Array.from(sentence.trim());
  return characters.length > 80 ? characters.slice(0, 79).join("") + "…" : characters.join("");
}

function objectOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : {};
}
