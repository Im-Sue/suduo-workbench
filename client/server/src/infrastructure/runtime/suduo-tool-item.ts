import type { JsonValue } from "@suduo/client-contracts";

/**
 * 账本里 SuDuo 工具调用的形状（技术设计 2.2）：不论经 dynamicTools 还是 SuDuo MCP、不论哪家 Agent，
 * 都落成 `dynamicToolCall`，界面、房间进度、图片瘦身只认这一种。
 */

/** 时间线里工具结果的文本上限；完整结果模型已经拿到，账本只留可读摘要。 */
const TOOL_TEXT_LIMIT = 4_000;
/**
 * 图片 data URL 不进事件账本（一张截图就是几 MB）。占位只是数据标记：界面按 inputImage 显示自己语言的「（图片）」，
 * Agent 拿到的是原图，所以写英文、不随会话语言变。
 */
export const OMITTED_IMAGE_URL = "[image omitted]";
/**
 * 账本里工具结果截断后接的标记。这一层拿不到会话语言，界面又会照原文显示它，
 * 所以只用与语言无关的省略号（工具结果本身已按会话语言写）。
 */
const TOOL_TEXT_CLIPPED = "\n…";

/** 图片换成占位、长文本截断；其他内容原样。 */
export function slimToolContentItems(items: readonly JsonValue[]): JsonValue[] {
  return items.map((entry): JsonValue => {
    const content = asObject(entry);
    if (content["type"] === "inputImage") {
      return { type: "inputImage", imageUrl: OMITTED_IMAGE_URL };
    }
    if (content["type"] === "inputText" && typeof content["text"] === "string") {
      const text = content["text"];
      return { type: "inputText", text: text.length > TOOL_TEXT_LIMIT ? text.slice(0, TOOL_TEXT_LIMIT) + TOOL_TEXT_CLIPPED : text };
    }
    return entry;
  });
}

/** MCP 的结果内容（text / image）→ SuDuo 工具调用的 inputText / inputImage。 */
export function mcpContentItem(entry: JsonValue): JsonValue {
  const content = asObject(entry);
  if (content["type"] === "text" && typeof content["text"] === "string") {
    return { type: "inputText", text: content["text"] };
  }
  if (content["type"] === "image" && typeof content["data"] === "string" && typeof content["mimeType"] === "string") {
    return { type: "inputImage", imageUrl: `data:${content["mimeType"]};base64,${content["data"]}` };
  }
  return { type: "inputText", text: JSON.stringify(entry) };
}

/** SuDuo MCP 工具名（去前缀）→ 账本里的内部名。 */
export function suDuoInternalToolName(mcpName: string): string {
  return "suduo_" + mcpName;
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : {};
}
