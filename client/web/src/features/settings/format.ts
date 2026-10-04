import type { Locale } from "@suduo/client-contracts";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor } from "../../i18n/messages/index.js";
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
