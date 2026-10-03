/**
 * 附件在线预览（`?disposition=inline`）的安全类型白名单。
 *
 * 前端据附件 `contentType`（产物文件没有该字段时用文件名）乐观决定是否显示「预览」；
 * 是否真的内联由本机服务决定：文件名扩展名对应的类型须在白名单内，且文件头嗅探结果
 * 与之一致，否则按下载返回。SVG、HTML、XML、JS 等可执行脚本的类型一律不在此列。
 */
export const ATTACHMENT_INLINE_PREVIEW_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
] as const;

export type AttachmentInlinePreviewType =
  (typeof ATTACHMENT_INLINE_PREVIEW_TYPES)[number];

const INLINE_PREVIEW_TYPES_BY_EXTENSION: Readonly<Record<string, AttachmentInlinePreviewType>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};

/** 去掉参数、转小写后若在白名单内返回该类型，否则返回 null。 */
export function attachmentInlinePreviewType(
  contentType: string | null | undefined,
): AttachmentInlinePreviewType | null {
  const essence = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (ATTACHMENT_INLINE_PREVIEW_TYPES as readonly string[]).includes(essence)
    ? essence as AttachmentInlinePreviewType
    : null;
}

/** 声明的 MIME 类型是否属于可在线预览的安全类型（乐观判断，以服务端嗅探为准）。 */
export function isAttachmentInlinePreviewType(contentType: string | null | undefined): boolean {
  return attachmentInlinePreviewType(contentType) !== null;
}

/** 按文件名扩展名（不分大小写）推断可在线预览的类型；不在白名单内返回 null。 */
export function attachmentInlinePreviewTypeForFileName(
  fileName: string,
): AttachmentInlinePreviewType | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return INLINE_PREVIEW_TYPES_BY_EXTENSION[fileName.slice(dot).toLowerCase()] ?? null;
}
