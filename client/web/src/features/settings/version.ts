import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";

declare const __SUDUO_VERSION__: string | undefined;

/**
 * SuDuo 版本号：构建时由 vite 从 client/package.json 注入；开发与测试环境没有注入时显示「开发版」。
 * 文字按调用时的界面语言取；组件里可以传入 useT() 拿到的字典。
 */
export function appVersion(t: Messages = messagesFor(currentLocale())): string {
  return typeof __SUDUO_VERSION__ === "string" && __SUDUO_VERSION__ !== "" ? __SUDUO_VERSION__ : t.settings.devBuild;
}

/** 构建时注入的本机版本；开发与测试环境没有注入时为 null。 */
export function builtVersion(): string | null {
  return typeof __SUDUO_VERSION__ === "string" && __SUDUO_VERSION__ !== "" ? __SUDUO_VERSION__ : null;
}

export type VersionMatch = "same" | "different" | "unknown";

/** 本机与云端版本比对：任一方不知道版本（开发版、较早的云端、报告 "dev" 的源码运行云端）时为 unknown，只做提示用（ADR-0004）。 */
export function compareWithCloud(local: string | null, cloud: string | null | undefined): VersionMatch {
  if (local === null || cloud === null || cloud === undefined || cloud === "dev") return "unknown";
  return local === cloud ? "same" : "different";
}
