import type { Locale } from "@suduo/client-contracts";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";
import { formatDate, formatMonthDay, type DateInput } from "../../ui/format.js";

/** 日期：今年内「10月28日」，跨年「2027年1月3日」；无效日期显示「未知」。 */
export function formatDay(value: DateInput, now: Date = new Date(), locale: Locale = currentLocale()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return messagesFor(locale).settings.unknownDate;
  return date.getFullYear() === now.getFullYear() ? formatMonthDay(date, locale) : formatDate(date, locale);
}

/** 本机路径缩写：家目录下显示为 ~/…（完整路径放在 title 里）。 */
export function shortenPath(path: string): string {
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/.exec(path);
  return match === null ? path : `~${path.slice(match[1]!.length)}`;
}

/**
 * 代理服务端校验信息里的字段名换成界面上的叫法。字段名与语言无关，叫法按调用时的界面语言取；
 * 组件里可以传入 useT() 拿到的字典。
 */
export function humanizeProxyMessage(message: string, t: Messages = messagesFor(currentLocale())): string {
  const labels: Readonly<Record<string, string>> = t.settings.fields.proxy;
  return message.replace(/\b(httpProxy|httpsProxy|allProxy|noProxy)\b/g, (field) => labels[field] ?? field);
}

/** 模型服务端校验信息里的字段名换成界面上的叫法（D1：不对用户露出接口字段名）。 */
export function humanizeModelMessage(message: string, t: Messages = messagesFor(currentLocale())): string {
  const labels: Readonly<Record<string, string>> = t.settings.fields.model;
  return message.replace(/\b(baseUrl|apiKey|model|reasoningEffort|contextWindow)\b/g, (field) => labels[field] ?? field);
}
