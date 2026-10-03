import {
  BACKFILL_OMITTED_EVENT_TYPES,
  BACKFILL_LATEST_ONLY_EVENT_TYPES,
  type EventEnvelope,
  type JsonValue,
} from "@suduo/client-contracts";

/**
 * 房间任务的执行过程：进度一句话（与前端时间线同口径）、回写给远程的事件（截断）、失败原因人话化。
 */

type StepKind = "read" | "search" | "list" | "command" | "tool" | "web" | "other";

/** 与前端 `features/sessions/stream/describe.ts` 的步骤组摘要同一套措辞与顺序。 */
const PROGRESS_PARTS: Array<{ kind: StepKind; phrase(count: number): string }> = [
  { kind: "read", phrase: (count) => `查看了 ${count} 个文件` },
  { kind: "search", phrase: (count) => `搜索了 ${count} 次` },
  { kind: "list", phrase: (count) => `列了 ${count} 个目录` },
  { kind: "command", phrase: (count) => `运行了 ${count} 条命令` },
  { kind: "tool", phrase: (count) => `调用了 ${count} 次工具` },
  { kind: "web", phrase: (count) => `搜索了 ${count} 次网页` },
];

/** 按本回合的 item 统计进度：「查看了 6 个文件 · 运行了 2 条命令 · 调用了 1 次工具」。 */
export class RunProgressTracker {
  private readonly steps = new Map<string, StepKind>();

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

  text(): string {
    const parts: string[] = [];
    for (const part of PROGRESS_PARTS) {
      let count = 0;
      for (const kind of this.steps.values()) {
        if (kind === part.kind) count += 1;
      }
      if (count > 0) parts.push(part.phrase(count));
    }
    return parts.length === 0 ? "正在思考" : parts.join(" · ");
  }
}

function classifyItem(item: Record<string, JsonValue>): StepKind | null {
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
 * - 单条里的长文本截到 4000 字；整段超过 1.5MB 时丢中间、保留开头与结尾，并在末尾加一条说明。
 * 只为控制体积，不是脱敏（需求「执行过程对房间完整可见」）。
 */
export function compactRunEvents(
  events: ReadonlyArray<EventEnvelope<string, JsonValue>>,
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
      payload: clipStrings(stripExtensions(event.payload), limits.stringChars),
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
      code: "room-run-events-truncated",
      message: `执行过程太长，中间省略了 ${omitted} 条记录（保留了开头和结尾）。完整过程在所有者本机的房间任务会话里。`,
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

function clipStrings(value: JsonValue, limit: number): JsonValue {
  if (typeof value === "string") {
    const text = withoutNul(value);
    return text.length > limit ? text.slice(0, limit) + `…（以下省略，共 ${text.length} 字）` : text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => clipStrings(item, limit));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[withoutNul(key)] = clipStrings(item, limit);
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

/** 与前端 `event-projection/shared.ts` 同口径的 Codex 错误人话化（任务失败原因给房间里的人看）。 */
const CODEX_ERROR_TEXT: Record<string, string> = {
  contextWindowExceeded: "这段对话已经超出模型的上下文窗口。可以在新话题里重新 @，或请所有者处理。",
  usageLimitExceeded: "所有者的模型用量已经到上限，请稍后再试。",
  unauthorized: "所有者电脑上的模型服务认证失败（401），需要所有者检查模型服务设置。",
  serverOverloaded: "模型服务现在很忙，请稍等一会儿再重试。",
  internalServerError: "模型服务暂时出错，请稍后重试。",
  badRequest: "模型服务拒绝了这次请求，可能是参数或附件不被支持。",
  sandboxError: "命令没能在只读沙箱里运行。",
  rateLimitExceeded: "模型服务限流了，请稍等几分钟再重试。",
  misalignmentPolicyViolation: "这次请求触发了模型服务的安全策略，已停止。可以换个说法再试。",
  sessionBudgetExceeded: "这个话题的用量预算已经用完，可以在新话题里重新 @。",
  cyberPolicy: "请求涉及网络安全相关内容，被模型服务的安全策略拦下了。",
};

export function describeTurnFailure(payload: JsonValue): string {
  const turn = objectOf(objectOf(payload)["turn"]);
  const error = objectOf(turn["error"] ?? objectOf(payload)["error"]);
  const info = error["codexErrorInfo"];
  if (typeof info === "string" && CODEX_ERROR_TEXT[info] !== undefined) {
    return CODEX_ERROR_TEXT[info];
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
  if (/429|too many requests/iu.test(text)) return "模型服务限流（429），请稍等几分钟再重试。";
  if (/401|unauthorized|authentication/iu.test(text)) return "所有者电脑上的模型服务认证失败（401），需要所有者检查模型服务设置。";
  if (/403|forbidden/iu.test(text)) return "模型服务拒绝了请求（403），所有者的凭证可能没有权限使用这个模型。";
  if (/5\d\d|internal server error|bad gateway|service unavailable/iu.test(text)) return "模型服务暂时出错，请稍后重试。";
  if (/timeout|timed out/iu.test(text)) return "模型服务响应超时，请稍后重试。";
  return text === "" ? "执行失败，原因未知。" : `执行失败：${text.slice(0, 500)}`;
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
