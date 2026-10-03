import type { Locale } from "@suduo/client-contracts";
import { en } from "./en/index.js";
import { zhCN, type ServerMessages } from "./zh-CN/index.js";

export type { ServerMessages };

const DICTIONARIES: Record<Locale, ServerMessages> = { "zh-CN": zhCN, en };

export function messagesFor(locale: Locale): ServerMessages {
  return DICTIONARIES[locale];
}

/** 所有语言的字典，识别「任一语言写下的文字」时用（如检查点标题前缀）。 */
export function allMessages(): readonly ServerMessages[] {
  return Object.values(DICTIONARIES);
}
