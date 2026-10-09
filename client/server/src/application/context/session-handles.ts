import type { JsonValue } from "@suduo/client-contracts";

/**
 * 消息里引用本机别的会话的句柄（多 Agent 协作 S7，技术设计 2.8）：`suduo://session/<会话 ID>`。
 * 输入框 @ 会话时插入 `[会话标题](suduo://session/<ID>)`；Agent 按 ID 调 session_read 读取。
 */
const HANDLE = /suduo:\/\/session\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/giu;

/** 消息内容（文字段）里引用的会话 ID，去重、按出现顺序。 */
export function sessionHandles(content: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const item = part as Record<string, JsonValue>;
    if (item["type"] !== "text" || typeof item["text"] !== "string") continue;
    for (const match of item["text"].matchAll(HANDLE)) ids.add(match[1]!.toLowerCase());
  }
  return [...ids];
}
