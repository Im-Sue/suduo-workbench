import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import {
  attachmentInlinePreviewTypeForFileName,
  type AttachmentInlinePreviewType,
} from "@suduo/client-contracts";
import { ApiError } from "../../application/api-error.js";

/** 嗅探读取的文件头上限：二进制签名只看前 12 字节，纯文本检查前 8KB。 */
export const INLINE_PREVIEW_SNIFF_BYTES = 8 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

// 图片与文本在独立文档里打开时只需加载自身和查看器的内联样式；sandbox 禁止脚本与同源权限。
const IMAGE_AND_TEXT_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
// Chromium 的 PDF 查看器在 sandbox 下不渲染，PDF 只收紧资源加载。
const PDF_CSP = "default-src 'none'";

export interface InlinePreviewDecision {
  /** 从第 0 字节开始的完整内容：嗅探读走的文件头先回放，其余继续流式转发。 */
  stream: Readable;
  /** 可内联时的响应头；null 表示按下载返回。 */
  headers: Record<string, string> | null;
}

/**
 * 处理 `?disposition=inline`：文件名扩展名对应的类型须在白名单内，且文件头嗅探结果与之一致，
 * 才返回内联响应头。上传时声明的类型与文件名都来自浏览器，不可信，嗅探是最终依据。
 * 不满足时不报错，由调用方按下载返回。
 */
export async function prepareInlinePreview(
  body: NodeWebReadableStream<Uint8Array>,
  remoteDisposition: string | null,
): Promise<InlinePreviewDecision> {
  const fileName = fileNameFromDisposition(remoteDisposition);
  const declared = fileName === null ? null : attachmentInlinePreviewTypeForFileName(fileName);
  if (fileName === null || declared === null) {
    return { stream: Readable.fromWeb(body), headers: null };
  }
  const peeked = await peekStream(body, INLINE_PREVIEW_SNIFF_BYTES);
  const sniffed = sniffInlinePreviewType(peeked.head, peeked.complete);
  return {
    stream: peeked.stream,
    headers: sniffed === declared ? inlinePreviewHeaders(sniffed, fileName) : null,
  };
}

/**
 * 按文件头识别白名单类型：PNG / JPEG / GIF / WEBP / PDF 看签名；都不是时，
 * 样本是合法 UTF-8 且不含 NUL 即视为纯文本。`complete` 表示样本就是完整文件，
 * 否则样本末尾被截断的多字节字符不算非法。
 */
export function sniffInlinePreviewType(
  head: Uint8Array,
  complete: boolean,
): AttachmentInlinePreviewType | null {
  if (startsWithBytes(head, PNG_SIGNATURE)) return "image/png";
  if (startsWithBytes(head, JPEG_SIGNATURE)) return "image/jpeg";
  if (startsWithAscii(head, "GIF87a") || startsWithAscii(head, "GIF89a")) return "image/gif";
  if (startsWithAscii(head, "RIFF") && startsWithAscii(head.subarray(8), "WEBP")) {
    return "image/webp";
  }
  if (startsWithAscii(head, "%PDF-")) return "application/pdf";
  return isPlainUtf8Text(head, complete) ? "text/plain" : null;
}

/** 从远端 Content-Disposition 取文件名：优先 RFC 5987 的 `filename*`，其次 `filename`。 */
export function fileNameFromDisposition(header: string | null): string | null {
  if (header === null) return null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;\s]+)/iu.exec(header);
  if (extended?.[1] !== undefined) {
    try {
      const decoded = decodeURIComponent(extended[1]);
      if (decoded !== "") return decoded;
    } catch {
      // 编码无效时退回普通 filename。
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/iu.exec(header);
  const value = plain?.[1]?.replace(/\\(.)/gu, "$1") ?? plain?.[2];
  return value === undefined || value === "" ? null : value;
}

function inlinePreviewHeaders(
  type: AttachmentInlinePreviewType,
  fileName: string,
): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Type": type === "text/plain" ? "text/plain; charset=utf-8" : type,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeRfc5987Value(fileName)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": type === "application/pdf" ? PDF_CSP : IMAGE_AND_TEXT_CSP,
  };
}

/** encodeURIComponent 之外再编码 RFC 5987 attr-char 不允许的 ' ( ) *。 */
function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 读取流开头至少 `size` 字节（或读到结束）用于嗅探，不把整个文件读进内存；
 * 返回的流先回放已读的块，再继续从原流读取。
 */
async function peekStream(
  body: NodeWebReadableStream<Uint8Array>,
  size: number,
): Promise<{ head: Uint8Array; complete: boolean; stream: Readable }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let buffered = 0;
  let complete = false;
  try {
    while (buffered < size) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      chunks.push(next.value);
      buffered += next.value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", (t) => t.workspace.attachment.remoteReadFailed, undefined, {
      cause: error,
    });
  }
  const head = Buffer.concat(chunks).subarray(0, size);
  async function* replay(): AsyncGenerator<Uint8Array> {
    let finished = complete;
    try {
      yield* chunks.splice(0);
      while (!finished) {
        const next = await reader.read();
        if (next.done) {
          finished = true;
          return;
        }
        yield next.value;
      }
    } finally {
      // 下游提前关闭（如浏览器取消）时释放远端连接。
      if (!finished) await reader.cancel().catch(() => undefined);
    }
  }
  return { head, complete, stream: Readable.from(replay(), { objectMode: false }) };
}

function isPlainUtf8Text(sample: Uint8Array, complete: boolean): boolean {
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: !complete });
    return true;
  } catch {
    return false;
  }
}

function startsWithBytes(value: Uint8Array, prefix: readonly number[]): boolean {
  return value.length >= prefix.length && prefix.every((byte, index) => value[index] === byte);
}

function startsWithAscii(value: Uint8Array, prefix: string): boolean {
  return startsWithBytes(value, Array.from(prefix, (character) => character.charCodeAt(0)));
}
