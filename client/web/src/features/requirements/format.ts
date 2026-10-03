import { attachmentInlinePreviewTypeForFileName } from "@suduo/client-contracts";
import { formatRequirementNumber } from "@suduo/cloud-contracts";
import { differenceInMinutes, format, isSameDay, isSameYear, subDays } from "date-fns";

/**
 * 需求模块的展示格式（技术设计 §8 文案规范）。
 * - 需求用编号指代（REQ-128），不出现 UUID；
 * - 时间：1 小时内相对时间，今天 "14:32"，昨天 "昨天 14:32"，今年 "9月27日"，更早 "2025年9月27日"；
 * - 大小用 KB / MB。
 */

export function requirementCode(number: number | null | undefined): string {
  return typeof number === "number" && number > 0 ? formatRequirementNumber(number) : "REQ-—";
}

export function formatRelativeTime(value: string | number | Date, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = differenceInMinutes(now, date);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  // 今天 / 昨天 / 今年都按传入的 now 判断（不用 isToday 这类读系统时钟的函数），与相对时间同一个基准。
  if (isSameDay(date, now)) return format(date, "HH:mm");
  if (isSameDay(date, subDays(now, 1))) return `昨天 ${format(date, "HH:mm")}`;
  if (isSameYear(date, now)) return format(date, "M月d日");
  return format(date, "yyyy年M月d日");
}

/** 悬停时显示的完整时间。 */
export function formatFullTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : format(date, "yyyy年M月d日 HH:mm:ss");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 卡片 / 行里的一行描述预览：去掉常见 Markdown 标记，取第一段有内容的文字。 */
export function summaryPreview(markdown: string, maxLength = 140): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
        .replace(/[*_`~]+/g, "")
        .trim(),
    )
    .filter((line) => line !== "" && !/^[-=|:\s]+$/.test(line))
    .join(" ");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * 能否在线预览：按文件扩展名判断，与本机服务一致（服务端再用文件头嗅探确认，对不上就按下载返回）。
 * image 在应用内的灯箱打开，document（PDF、.txt）在新标签页打开；SVG、HTML 等一律只能下载。
 */
export function previewKind(fileName: string): "image" | "document" | null {
  const type = attachmentInlinePreviewTypeForFileName(fileName);
  if (type === null) return null;
  return type.startsWith("image/") ? "image" : "document";
}

export function inlineUrl(downloadUrl: string): string {
  return `${downloadUrl}${downloadUrl.includes("?") ? "&" : "?"}disposition=inline`;
}
