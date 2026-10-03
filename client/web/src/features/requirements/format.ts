import { attachmentInlinePreviewTypeForFileName } from "@suduo/client-contracts";
import { formatRequirementNumber } from "@suduo/cloud-contracts";

/**
 * 需求模块的展示格式（技术设计 §8 文案规范）。
 * - 需求用编号指代（REQ-128），不出现 UUID；
 * - 时间统一走 ui/format.ts（formatRelativeTime / formatDateTime）；
 * - 大小用 KB / MB。
 */

export function requirementCode(number: number | null | undefined): string {
  return typeof number === "number" && number > 0 ? formatRequirementNumber(number) : "REQ-—";
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
