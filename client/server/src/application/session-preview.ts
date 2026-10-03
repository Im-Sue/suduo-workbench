import type { JsonValue, SessionMessagePreviewDto } from "@suduo/client-contracts";

/** 会话列表「最后一句话」的最大字数（按字符计，超出以 … 结尾）。 */
export const SESSION_PREVIEW_MAX_CHARS = 120;

/** 折叠所有空白为单个空格并截断；幂等，读写两侧都可再套一次。 */
export function normalizePreviewText(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  const characters = Array.from(collapsed);
  if (characters.length <= SESSION_PREVIEW_MAX_CHARS) {
    return collapsed;
  }
  return characters.slice(0, SESSION_PREVIEW_MAX_CHARS).join("").trimEnd() + "…";
}

/**
 * 从一条入账事件推导「最后一句话」：用户消息取 message.submitted 的文本段，
 * 助手回复取 item.completed 里 agentMessage 的完整正文（不看流式增量）。
 * 没有文字（纯图片 / 纯 skill）或不是消息事件时返回 null，不改动已有预览。
 */
export function sessionMessagePreview(event: {
  type: string;
  payload: JsonValue;
}): SessionMessagePreviewDto | null {
  const payload = asObject(event.payload);
  if (event.type === "message.submitted") {
    const content = payload["content"];
    if (!Array.isArray(content)) {
      return null;
    }
    const text = content
      .map((part) => {
        const item = asObject(part);
        return item["type"] === "text" && typeof item["text"] === "string" ? item["text"] : "";
      })
      .filter((part) => part !== "")
      .join(" ");
    return previewOf("user", text);
  }
  if (event.type === "item.completed") {
    const item = asObject(payload["item"]);
    if (item["type"] !== "agentMessage" || typeof item["text"] !== "string") {
      return null;
    }
    return previewOf("assistant", item["text"]);
  }
  return null;
}

function previewOf(
  role: SessionMessagePreviewDto["role"],
  text: string,
): SessionMessagePreviewDto | null {
  const normalized = normalizePreviewText(text);
  return normalized === "" ? null : { role, text: normalized };
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : {};
}
