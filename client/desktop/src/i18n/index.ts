import { en } from "./en.js";
import { zhCN, type DesktopMessages } from "./zh-CN.js";

export type DesktopLocale = "zh-CN" | "en";
export type { DesktopMessages };

export function desktopMessages(locale: DesktopLocale): DesktopMessages {
  return locale === "zh-CN" ? zhCN : en;
}

/**
 * 外壳文字的语言（技术设计 §4.7）：前端告知的 → 本机服务记下的界面语言 → 系统语言（zh 开头取中文，其余英文）。
 * 传进来的值不可信（文件、IPC），不认识的一律跳过。
 */
export function chooseDesktopLocale(input: {
  announced?: string | null;
  stored?: string | null;
  system: string;
}): DesktopLocale {
  for (const candidate of [input.announced, input.stored]) {
    if (candidate === "zh-CN" || candidate === "en") return candidate;
  }
  return /^zh\b/i.test(input.system) ? "zh-CN" : "en";
}

/** 本机服务记下的界面语言文件（server/src/i18n/ui-locale-store.ts：settings.json 旁边的 settings.locale.json）的内容。 */
export function parseStoredLocale(text: string | null): string | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && "locale" in value) {
      const locale = (value as { locale: unknown }).locale;
      return typeof locale === "string" ? locale : null;
    }
  } catch {
    // 文件被手改坏：当成没有。
  }
  return null;
}
