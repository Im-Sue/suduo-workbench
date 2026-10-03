import type { Locale } from "@suduo/client-contracts";
import { currentLocale } from "../i18n/locale.js";
import { messagesFor } from "../i18n/messages/index.js";

export function formatBytes(value: number): string {
  if (value < 1024) {
    return `${String(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 全站日期与时长的格式（中英双语技术设计 §4.3：日期与数字一律走这里）。
 * 默认用当前界面语言；切换语言时整棵界面会重建，所以不订阅语言的调用方也会更新。
 */
export type DateInput = string | number | Date;

function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function previousDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
}

/** 中文月份用「9月」（long），英文用「Sep」（short）。 */
function monthStyle(locale: Locale): "long" | "short" {
  return locale === "zh-CN" ? "long" : "short";
}

/** 时:分，24 小时制：14:32。 */
export function formatClock(value: DateInput, locale: Locale = currentLocale()): string {
  const date = toDate(value);
  return date === null
    ? ""
    : new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

/** 月日：9月27日 / Sep 27。 */
export function formatMonthDay(value: DateInput, locale: Locale = currentLocale()): string {
  const date = toDate(value);
  return date === null
    ? ""
    : new Intl.DateTimeFormat(locale, { month: monthStyle(locale), day: "numeric" }).format(date);
}

/** 年月日：2025年9月27日 / Sep 27, 2025。 */
export function formatDate(value: DateInput, locale: Locale = currentLocale()): string {
  const date = toDate(value);
  return date === null
    ? ""
    : new Intl.DateTimeFormat(locale, { year: "numeric", month: monthStyle(locale), day: "numeric" }).format(date);
}

/** 悬停时显示的完整时间：2025年9月27日 14:32:05 / Sep 27, 2025, 14:32:05。 */
export function formatDateTime(value: DateInput, locale: Locale = currentLocale()): string {
  const date = toDate(value);
  return date === null
    ? ""
    : new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: monthStyle(locale),
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(date);
}

/**
 * 相对时间：1 分钟内「刚刚」，1 小时内「N 分钟前」，今天「14:32」，昨天「昨天 14:32」，
 * 今年「9月27日」，更早「2025年9月27日」。今天 / 昨天都按传入的 now 判断，与相对时间同一个基准。
 */
export function formatRelativeTime(
  value: DateInput,
  now: Date = new Date(),
  locale: Locale = currentLocale(),
): string {
  const date = toDate(value);
  if (date === null) return "";
  const text = messagesFor(locale).common.time;
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return text.justNow;
  if (minutes < 60) return text.minutesAgo(minutes);
  if (sameDay(date, now)) return formatClock(date, locale);
  if (sameDay(date, previousDay(now))) return text.yesterdayAt(formatClock(date, locale));
  if (date.getFullYear() === now.getFullYear()) return formatMonthDay(date, locale);
  return formatDate(date, locale);
}

/** 按天分隔的标题：今天 / 昨天 / 9月27日 / 2025年9月27日。 */
export function formatDayLabel(
  value: DateInput,
  now: Date = new Date(),
  locale: Locale = currentLocale(),
): string {
  const date = toDate(value);
  if (date === null) return "";
  const text = messagesFor(locale).common.time;
  if (sameDay(date, now)) return text.today;
  if (sameDay(date, previousDay(now))) return text.yesterday;
  if (date.getFullYear() === now.getFullYear()) return formatMonthDay(date, locale);
  return formatDate(date, locale);
}

/** 本地日期键 yyyy-MM-dd（分组用，不显示）。 */
export function dayKey(value: DateInput): string {
  const date = toDate(value);
  if (date === null) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 时长：12 秒 / 3 分钟 / 3 分 5 秒；不足 1 秒按 1 秒。 */
export function formatDuration(ms: number, locale: Locale = currentLocale()): string {
  const text = messagesFor(locale).common.duration;
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) {
    return text.seconds(seconds);
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? text.minutes(minutes) : text.minutesSeconds(minutes, rest);
}

/** 新会话默认名：新会话 MM-DD HH:mm。 */
export function defaultSessionTitle(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `新会话 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** child 是否位于 parent 目录内（大小写与分隔符不敏感，用于全局 skill 判定）。 */
export function isSubPath(child: string, parent: string): boolean {
  if (!child || !parent) {
    return false;
  }
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const normalizedChild = normalize(child);
  const normalizedParent = normalize(parent);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(normalizedParent + "/")
  );
}
