import type { Locale } from "@suduo/client-contracts";
import { en } from "./en/index.js";
import { zhCN, type Messages } from "./zh-CN/index.js";

export type { Messages };

const DICTIONARIES: Record<Locale, Messages> = { "zh-CN": zhCN, en };

export function messagesFor(locale: Locale): Messages {
  return DICTIONARIES[locale];
}
