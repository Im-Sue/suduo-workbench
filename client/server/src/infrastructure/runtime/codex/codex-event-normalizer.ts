import {
  SUDUO_MCP_SERVER_NAME,
  type JsonValue,
  type RpcInbound,
  type RuntimeEventDraft,
  type ThreadRef,
  type TurnRef,
} from "@suduo/client-contracts";

const EVENT_TYPE_BY_NATIVE_METHOD: Readonly<Record<string, string>> = {
  "thread/started": "thread.started",
  "thread/status/changed": "thread.status-changed",
  "turn/started": "turn.started",
  "item/agentMessage/delta": "message.delta",
  "item/started": "item.started",
  "item/completed": "item.completed",
  "item/commandExecution/outputDelta": "command.output-delta",
  "item/fileChange/patchUpdated": "file.patch-updated",
  "turn/diff/updated": "file.patch-updated",
  "turn/plan/updated": "plan.updated",
  "item/plan/delta": "plan.delta",
  "item/reasoning/summaryTextDelta": "reasoning.summary-delta",
  "item/reasoning/summaryPartAdded": "reasoning.summary-part-added",
  "item/reasoning/textDelta": "reasoning.text-delta",
  "thread/tokenUsage/updated": "usage.updated",
  "item/mcpToolCall/progress": "tool.progress",
  "thread/settings/updated": "thread.settings-updated",
  "model/rerouted": "model.rerouted",
  "fs/changed": "workspace.changed",
  warning: "runtime.warning",
  error: "runtime.error",
};

export function normalizeCodexNotification(input: {
  runtimeId: string;
  connectionId: string;
  ordinal: number;
  message: Extract<RpcInbound, { kind: "notification" }>;
  sessionHint?: string;
}): RuntimeEventDraft {
  const params = asObject(input.message.params);
  const threadId = extractThreadId(params);
  const turnId = extractTurnId(params);
  const threadRef =
    threadId === null
      ? null
      : {
          runtimeId: input.runtimeId,
          runtimeKind: "codex",
          threadId,
        };
  const turnRef =
    threadId !== null && turnId !== null ? { threadId, turnId } : null;
  const type = eventType(input.message.method, params);

  return {
    source: "runtime:" + input.runtimeId,
    type,
    payload: normalizePayload(input.message.method, params),
    threadRef,
    turnRef,
    ts: Date.now(),
    dedupeKey: input.connectionId + ":" + String(input.ordinal),
    ...(input.sessionHint === undefined
      ? {}
      : { sessionHint: input.sessionHint }),
  };
}

/**
 * 保留 Codex 原生通知名，供无会话全局通知按精确白名单分流。
 * 不以标准化后的 runtime.unknown 作判断，避免吞掉未知运行时故障。
 */
export function codexNativeType(event: RuntimeEventDraft): string | null {
  const payload = asObject(event.payload);
  const extensions = asObject(payload["extensions"]);
  const codex = asObject(extensions["codex"]);
  return typeof codex["nativeType"] === "string"
    ? codex["nativeType"]
    : null;
}

export function extractThreadRef(
  runtimeId: string,
  params: JsonValue | undefined,
): ThreadRef | null {
  const threadId = extractThreadId(asObject(params));
  return threadId === null
    ? null
    : {
        runtimeId,
        runtimeKind: "codex",
        threadId,
      };
}

export function extractTurnRef(
  params: JsonValue | undefined,
): TurnRef | null {
  const object = asObject(params);
  const threadId = extractThreadId(object);
  const turnId = extractTurnId(object);
  return threadId !== null && turnId !== null
    ? {
        threadId,
        turnId,
      }
    : null;
}

function eventType(method: string, params: Record<string, JsonValue>): string {
  if (method === "turn/completed") {
    const turn = asObject(params["turn"]);
    return turn["status"] === "interrupted"
      ? "turn.interrupted"
      : "turn.completed";
  }
  return EVENT_TYPE_BY_NATIVE_METHOD[method] ?? "runtime.unknown";
}

function normalizePayload(
  method: string,
  rawParams: Record<string, JsonValue>,
): JsonValue {
  const params = sanitizeDynamicToolItem(method, adoptSuDuoMcpItem(method, rawParams));
  const extensions = {
    codex: {
      nativeType: method,
      params,
    },
  };
  if (method === "item/agentMessage/delta") {
    return {
      text: typeof params["delta"] === "string" ? params["delta"] : "",
      itemId: stringOrNull(params["itemId"]),
      extensions,
    };
  }
  if (method === "item/commandExecution/outputDelta") {
    return {
      delta: typeof params["delta"] === "string" ? params["delta"] : "",
      itemId: stringOrNull(params["itemId"]),
      extensions,
    };
  }
  if (method === "item/fileChange/patchUpdated") {
    return {
      changes: params["changes"] ?? [],
      itemId: stringOrNull(params["itemId"]),
      extensions,
    };
  }
  if (method === "turn/diff/updated") {
    return {
      diff: typeof params["diff"] === "string" ? params["diff"] : "",
      extensions,
    };
  }
  // 高频增量只放前端需要的字段（与 message.delta 同形），原生副本仍在 extensions.codex。
  if (method === "item/plan/delta") {
    return {
      itemId: stringOrNull(params["itemId"]),
      delta: stringOrEmpty(params["delta"]),
      extensions,
    };
  }
  if (method === "item/reasoning/summaryTextDelta") {
    return {
      itemId: stringOrNull(params["itemId"]),
      delta: stringOrEmpty(params["delta"]),
      summaryIndex: integerOrNull(params["summaryIndex"]),
      extensions,
    };
  }
  if (method === "item/reasoning/summaryPartAdded") {
    return {
      itemId: stringOrNull(params["itemId"]),
      summaryIndex: integerOrNull(params["summaryIndex"]),
      extensions,
    };
  }
  if (method === "item/reasoning/textDelta") {
    return {
      itemId: stringOrNull(params["itemId"]),
      delta: stringOrEmpty(params["delta"]),
      contentIndex: integerOrNull(params["contentIndex"]),
      extensions,
    };
  }
  // 低频快照类：原生字段平铺到顶层（含 threadId / turnId），再把关键字段规整成稳定形状。
  if (method === "turn/plan/updated") {
    return {
      ...params,
      explanation: stringOrNull(params["explanation"]),
      plan: normalizePlanSteps(params["plan"]),
      extensions,
    };
  }
  if (method === "thread/tokenUsage/updated") {
    const tokenUsage = params["tokenUsage"];
    return {
      ...params,
      tokenUsage:
        tokenUsage !== null &&
        tokenUsage !== undefined &&
        typeof tokenUsage === "object" &&
        !Array.isArray(tokenUsage)
          ? tokenUsage
          : null,
      extensions,
    };
  }
  if (method === "item/mcpToolCall/progress") {
    return {
      ...params,
      itemId: stringOrNull(params["itemId"]),
      message: stringOrEmpty(params["message"]),
      extensions,
    };
  }
  return {
    ...params,
    extensions,
  };
}

/** 计划步骤原样透传 step / status（Codex TurnPlanStepStatus），丢弃形状不对的条目。 */
function normalizePlanSteps(value: JsonValue | undefined): JsonValue {
  if (!Array.isArray(value)) {
    return [];
  }
  const steps: JsonValue[] = [];
  for (const entry of value) {
    const step = asObject(entry);
    if (typeof step["step"] !== "string") {
      continue;
    }
    steps.push({
      step: step["step"],
      status: typeof step["status"] === "string" ? step["status"] : "pending",
    });
  }
  return steps;
}

function extractThreadId(params: Record<string, JsonValue>): string | null {
  if (typeof params["threadId"] === "string") {
    return params["threadId"];
  }
  const thread = asObject(params["thread"]);
  return typeof thread["id"] === "string" ? thread["id"] : null;
}

function extractTurnId(params: Record<string, JsonValue>): string | null {
  if (typeof params["turnId"] === "string") {
    return params["turnId"];
  }
  const turn = asObject(params["turn"]);
  return typeof turn["id"] === "string" ? turn["id"] : null;
}

function asObject(
  value: JsonValue | undefined,
): Record<string, JsonValue> {
  return value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : {};
}

function stringOrNull(value: JsonValue | undefined): JsonValue {
  return typeof value === "string" ? value : null;
}

function stringOrEmpty(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function integerOrNull(value: JsonValue | undefined): JsonValue {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** 时间线里自定义工具结果的文本上限；完整结果模型已经拿到，账本只留可读摘要。 */
const DYNAMIC_TOOL_TEXT_LIMIT = 4_000;
/**
 * 图片 data URL 不进事件账本（一张截图就是几 MB）。占位只是数据标记：界面按 inputImage 显示自己语言的「（图片）」，
 * Codex 拿到的是原图，所以写英文、不随会话语言变。
 */
export const OMITTED_IMAGE_URL = "[image omitted]";
/**
 * 账本里工具结果截断后接的标记。这一层只认线程、拿不到会话语言，界面又会照原文显示它，
 * 所以只用与语言无关的省略号（工具结果本身已按会话语言写）。
 */
const DYNAMIC_TOOL_TEXT_CLIPPED = "\n…";

/**
 * 经 SuDuo 本机 MCP 工具服务（ADR-0015）的调用，Codex 记为 mcpToolCall（服务 suduo）。账本里 SuDuo 工具调用
 * 只有一种形状（ADR-0014：SuDuo 自己的 item 模型），所以换成与 dynamicTools 通道相同的 dynamicToolCall：
 * 工具名补回 suduo_ 前缀，结果内容换成 inputText / inputImage，界面、房间进度、图片瘦身都照旧。
 */
function adoptSuDuoMcpItem(method: string, params: Record<string, JsonValue>): Record<string, JsonValue> {
  if (method !== "item/started" && method !== "item/completed") {
    return params;
  }
  const item = asObject(params["item"]);
  if (item["type"] !== "mcpToolCall" || item["server"] !== SUDUO_MCP_SERVER_NAME || typeof item["tool"] !== "string") {
    return params;
  }
  const status = typeof item["status"] === "string" ? item["status"] : "inProgress";
  const error = asObject(item["error"]);
  const result = asObject(item["result"]);
  const contentItems: JsonValue[] | null =
    typeof error["message"] === "string"
      ? [{ type: "inputText", text: error["message"] }]
      : Array.isArray(result["content"])
        ? result["content"].map(mcpContentItem)
        : null;
  return {
    ...params,
    item: {
      type: "dynamicToolCall",
      id: item["id"] ?? null,
      namespace: null,
      tool: "suduo_" + item["tool"],
      arguments: item["arguments"] ?? null,
      status,
      contentItems,
      success: status === "inProgress" ? null : status === "completed" && item["error"] == null,
      durationMs: item["durationMs"] ?? null,
    },
  };
}

function mcpContentItem(entry: JsonValue): JsonValue {
  const content = asObject(entry);
  if (content["type"] === "text" && typeof content["text"] === "string") {
    return { type: "inputText", text: content["text"] };
  }
  if (content["type"] === "image" && typeof content["data"] === "string" && typeof content["mimeType"] === "string") {
    return { type: "inputImage", imageUrl: `data:${content["mimeType"]};base64,${content["data"]}` };
  }
  return { type: "inputText", text: JSON.stringify(entry) };
}

/**
 * 自定义工具调用（ADR-0008）的 item 原样落库会带上整张图片的 data URL 和大段文本：
 * 图片换成占位，文本截断。只动 dynamicToolCall，其他 item 不碰。
 */
function sanitizeDynamicToolItem(
  method: string,
  params: Record<string, JsonValue>,
): Record<string, JsonValue> {
  if (method !== "item/started" && method !== "item/completed") {
    return params;
  }
  const item = asObject(params["item"]);
  if (item["type"] !== "dynamicToolCall" || !Array.isArray(item["contentItems"])) {
    return params;
  }
  const contentItems = item["contentItems"].map((entry): JsonValue => {
    const content = asObject(entry);
    if (content["type"] === "inputImage") {
      return { type: "inputImage", imageUrl: OMITTED_IMAGE_URL };
    }
    if (content["type"] === "inputText" && typeof content["text"] === "string") {
      const text = content["text"];
      return {
        type: "inputText",
        text:
          text.length > DYNAMIC_TOOL_TEXT_LIMIT
            ? text.slice(0, DYNAMIC_TOOL_TEXT_LIMIT) + DYNAMIC_TOOL_TEXT_CLIPPED
            : text,
      };
    }
    return entry;
  });
  return { ...params, item: { ...item, contentItems } };
}
