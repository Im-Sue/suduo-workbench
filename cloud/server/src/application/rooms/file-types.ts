import { basename, extname } from "node:path";
import type { RoomFileKind } from "@suduo/cloud-contracts";
import { ApplicationError } from "../errors.js";

/**
 * 房间文件的类型策略：允许的扩展名、按扩展名定的内容类型、展示种类、能否内联。
 * 内容类型以扩展名为准（浏览器给的 multipart 类型常是 octet-stream），
 * 保证视频 / 图片能被浏览器直接播放、预览。
 */
const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  // 图片
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  // 视频
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  // 文档
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  // 压缩包
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
};

/** 缺省允许的扩展名（`REQUIREMENTS_ALLOWED_ROOM_FILE_EXTENSIONS` 可覆盖）。 */
export const DEFAULT_ROOM_FILE_EXTENSIONS: readonly string[] = Object.keys(EXTENSION_CONTENT_TYPES);

/** 内联时原样给出内容类型的种类（图片 / 视频 / pdf）。svg 能带脚本，不内联。 */
const INLINE_AS_IS = /^(image\/(png|jpeg|gif|webp|bmp|avif|heic)|video\/(mp4|x-m4v|quicktime|webm)|application\/pdf)$/u;
/** 内联时一律按纯文本给出的种类（不让浏览器当 HTML 渲染）。 */
const INLINE_AS_TEXT = /^(text\/(plain|markdown|csv|yaml)|application\/json)$/u;

export interface NormalizedRoomFile {
  fileName: string;
  extension: string;
  contentType: string;
}

/** 校验文件名与扩展名，算出存库用的内容类型。 */
export function normalizeRoomFile(
  rawFileName: string,
  rawContentType: string,
  allowedExtensions: ReadonlySet<string>,
): NormalizedRoomFile {
  const fileName = safeFileName(rawFileName);
  const extension = extname(fileName).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new ApplicationError(400, "ATTACHMENT_INVALID", "This file type is not allowed", { extension });
  }
  const contentType = EXTENSION_CONTENT_TYPES[extension] ?? safeContentType(rawContentType);
  return { fileName, extension, contentType };
}

export function roomFileKind(contentType: string): RoomFileKind {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return "file";
}

/**
 * 下载时的响应类型：`inline` 只对图片 / 视频 / pdf / 文本生效，其余一律附件下载；
 * 文本内联按 `text/plain` 给出，避免被当成页面执行。
 */
export function roomFileDisposition(
  contentType: string,
  requested: "inline" | "attachment" | undefined,
): { inline: boolean; contentType: string } {
  if (requested === "inline") {
    if (INLINE_AS_IS.test(contentType)) return { inline: true, contentType };
    if (INLINE_AS_TEXT.test(contentType)) return { inline: true, contentType: "text/plain; charset=utf-8" };
  }
  return { inline: false, contentType: "application/octet-stream" };
}

function safeFileName(input: string): string {
  const leaf = basename(input.replaceAll("\\", "/")).normalize("NFC");
  const value = Array.from(stripControls(leaf).trim()).slice(0, 200).join("");
  if (!value || value === "." || value === "..") {
    throw new ApplicationError(400, "ATTACHMENT_INVALID", "Invalid file name");
  }
  return value;
}

function safeContentType(input: string): string {
  const value = stripControls(input).trim().slice(0, 255);
  return value || "application/octet-stream";
}

function stripControls(input: string): string {
  return Array.from(input)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("");
}
