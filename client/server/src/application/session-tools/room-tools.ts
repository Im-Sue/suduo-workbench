import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { Locale } from "@suduo/client-contracts";
import type { RoomMessageDto } from "@suduo/cloud-contracts";
import type { RequirementsRemoteClient } from "../../infrastructure/requirements-v2/remote-client.js";
import {
  SUDUO_DIR,
  assertWritableInsideProject,
  ensureSuDuoDir,
} from "../../infrastructure/workspace/suduo-dir.js";
import { formatMessageLine, fullTime } from "../room-agent/message-format.js";
import { failure, formatBytes, textResult, toolFormat, type ToolResult } from "./format.js";
import { replaceUnsafePathCharacters } from "./requirement-dir.js";
import type { ToolSessionContext } from "./requirement-tools.js";

/**
 * 房间工具（技术设计 4.5，ADR-0009）：房间任务会话里的 Agent 按需翻房间历史、按关键词找消息、
 * 看房间里的图片与文件。全部只读；由 SuDuo 本机执行（不受 Codex 只读沙箱影响），
 * 查不到时写「查不到：原因」（三态，ADR-0004）。回包里 SuDuo 的说明按会话语言（`ctx.locale`），
 * 房间名、消息正文、人名、文件名原样。
 */

export type RoomToolsRemote = Pick<
  RequirementsRemoteClient,
  "listRoomMessages" | "searchRoomMessages" | "downloadRoomFile"
>;

/** 房间消息在工具结果里的正文上限。 */
const MESSAGE_BODY_LIMIT = 500;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** 图片直接交给模型看的上限；更大的存文件。 */
const INLINE_IMAGE_LIMIT = 8 * 1024 * 1024;
/** 文本类文件直接返回的字节上限与字数上限。 */
const INLINE_TEXT_BYTES = 64 * 1024;
const INLINE_TEXT_CHARS = 10_000;
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".log", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml",
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".java",
  ".kt", ".py", ".go", ".rs", ".sql", ".sh", ".properties", ".ini", ".toml",
]);

export class RoomTools {
  constructor(private readonly remote: RoomToolsRemote) {}

  async history(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.roomPrompt.tools;
    const room = ctx.room;
    if (!room) {
      return failure(text.notRoomSession.history);
    }
    const limit = clampLimit(args["limit"]);
    const beforeSeq = positiveInteger(args["beforeSeq"]);
    if (args["beforeSeq"] !== undefined && beforeSeq === null) {
      return failure(text.beforeSeqInvalid);
    }
    let page;
    try {
      page = await this.remote.listRoomMessages(room.roomId, {
        limit,
        ...(beforeSeq === null ? {} : { before: beforeSeq }),
      });
    } catch (error) {
      return f.unavailable(text.messagesWhat(room.roomName), error);
    }
    const items = sortBySeq(page.items);
    if (items.length === 0) {
      return textResult(beforeSeq === null ? text.historyEmpty(room.roomName) : text.historyNoEarlier(beforeSeq));
    }
    const first = items[0]!;
    const navigation = page.hasMoreBefore ? text.historyMore(first.seq) : text.historyStart;
    return textResult(
      [
        text.evidenceNote,
        "",
        text.historyHeader(room.roomName, first.seq, items.at(-1)!.seq, items.length),
        ...items.map((message) => lineOf(message, ctx.locale)),
        "",
        navigation,
      ].join("\n"),
    );
  }

  async search(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.roomPrompt.tools;
    const room = ctx.room;
    if (!room) {
      return failure(text.notRoomSession.search);
    }
    const query = typeof args["query"] === "string" ? args["query"].trim() : "";
    if (query === "") {
      return failure(text.queryMissing);
    }
    if (query.length > 200) {
      return failure(text.queryTooLong);
    }
    const limit = clampLimit(args["limit"]);
    let page;
    try {
      page = await this.remote.searchRoomMessages(room.roomId, { q: query, limit });
    } catch (error) {
      return f.unavailable(text.searchWhat(room.roomName, query), error);
    }
    const items = sortBySeq(page.items);
    if (items.length === 0) {
      return textResult(text.searchEmpty(room.roomName, query));
    }
    return textResult(
      [
        text.evidenceNote,
        "",
        text.searchHeader(room.roomName, query, items.length, page.hasMoreBefore),
        ...items.map((message) => lineOf(message, ctx.locale)),
      ].join("\n"),
    );
  }

  async fileView(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.roomPrompt.tools;
    const room = ctx.room;
    if (!room) {
      return failure(text.notRoomSession.fileView);
    }
    const fileId = typeof args["fileId"] === "string" ? args["fileId"].trim() : "";
    if (fileId === "") {
      return failure(text.fileIdMissing);
    }
    const abort = AbortSignal.timeout(30 * 60_000);
    let response: Response;
    try {
      // 必须要内联：需求服务只在 inline 时给出真实类型（图片原样、文本按 text/plain），
      // 附件下载一律是 application/octet-stream，图片就没法直接交给模型看。
      response = await this.remote.downloadRoomFile(fileId, { disposition: "inline", signal: abort });
    } catch (error) {
      return f.unavailable(text.fileWhat(fileId), error);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return failure(f.t.toolText.unavailable(text.fileWhat(fileId), text.httpStatus(response.status)));
    }
    const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    const declaredSize = Number(response.headers.get("content-length"));
    const size = Number.isSafeInteger(declaredSize) && declaredSize >= 0 ? declaredSize : null;
    const fileName = fileNameFromDisposition(response.headers.get("content-disposition")) ?? fileId;
    const head = text.fileHead(fileName, contentType, size === null ? null : formatBytes(size));
    const kind = fileKind(contentType, fileName);
    try {
      if (kind === "image" && size !== null && size <= INLINE_IMAGE_LIMIT) {
        const bytes = Buffer.from(await response.arrayBuffer());
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: head },
            { type: "inputImage", imageUrl: `data:${contentType};base64,${bytes.toString("base64")}` },
          ],
        };
      }
      if (kind === "text" && size !== null && size <= INLINE_TEXT_BYTES) {
        const bytes = Buffer.from(await response.arrayBuffer());
        const content = bytes.toString("utf8");
        if (content.length <= INLINE_TEXT_CHARS) {
          return textResult([head, text.evidenceNote, "", content].join("\n"));
        }
        const saved = await saveBytes(ctx, room, fileName, bytes, text.fallbackFileName);
        return textResult(`${head}\n${text.savedLongText(content.length, saved)}`);
      }
      const saved = await saveStream(
        ctx,
        room,
        fileName,
        response.body as NodeWebReadableStream<Uint8Array>,
        text.fallbackFileName,
      );
      return textResult(`${head}\n${text.saved(saved)}`);
    } catch (error) {
      await response.body.cancel().catch(() => undefined);
      return failure(text.fileFailed(fileName, f.reasonOf(error)));
    }
  }
}

function lineOf(message: RoomMessageDto, locale: Locale): string {
  const text = toolFormat(locale).t.roomPrompt.tools;
  const thread =
    message.threadRootId !== null
      ? text.threadReply
      : message.thread !== null && message.thread.replyCount > 0
        ? text.threadReplies(message.thread.replyCount)
        : "";
  return (
    formatMessageLine(message, {
      bodyLimit: MESSAGE_BODY_LIMIT,
      time: fullTime(message.createdAt),
      withTool: false,
      withSeq: true,
      locale,
    }) + thread
  );
}

function sortBySeq(items: readonly RoomMessageDto[]): RoomMessageDto[] {
  return [...items].sort((a, b) => a.seq - b.seq);
}

function clampLimit(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.floor(number));
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function fileKind(contentType: string, fileName: string): "image" | "text" | "other" {
  if (INLINE_IMAGE_TYPES.has(contentType)) {
    return "image";
  }
  if (contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/xml") {
    return "text";
  }
  const dot = fileName.lastIndexOf(".");
  const extension = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  return TEXT_EXTENSIONS.has(extension) ? "text" : "other";
}

/** 从 Content-Disposition 取文件名（优先 RFC 5987 的 filename*）。 */
export function fileNameFromDisposition(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const extended = /filename\*\s*=\s*([^;]+)/iu.exec(value);
  if (extended) {
    const raw = extended[1]!.trim().replace(/^"|"$/gu, "");
    const encoded = raw.includes("''") ? raw.slice(raw.indexOf("''") + 2) : raw;
    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded.trim() !== "") return decoded;
    } catch {
      // 编码坏了就退回普通 filename。
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/iu.exec(value);
  const name = plain ? (plain[2] ?? plain[1] ?? "").trim() : "";
  return name === "" ? null : name;
}

/** `.suduo/rooms/<房间名或 ID>/files/`：落盘前确认仍在项目目录里（防符号链接）。 */
async function roomFilesDir(ctx: ToolSessionContext, room: NonNullable<ToolSessionContext["room"]>): Promise<string> {
  const safeName = replaceUnsafePathCharacters(room.roomName, "-")
    .replace(/\s+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "");
  const clipped = Array.from(safeName).slice(0, 40).join("").replace(/[-.]+$/gu, "");
  const directory = join(ctx.projectRoot, SUDUO_DIR, "rooms", clipped === "" ? room.roomId : clipped, "files");
  await ensureSuDuoDir(ctx.projectRoot);
  await assertWritableInsideProject(ctx.projectRoot, directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** 落盘用的文件名；清理后为空（或 `.` / `..`）时用 `fallback`（按会话语言的「房间文件」）。 */
function safeFileName(fileName: string, fallback: string): string {
  const cleaned = replaceUnsafePathCharacters(basename(fileName), "_").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? fallback : cleaned;
}

async function saveBytes(
  ctx: ToolSessionContext,
  room: NonNullable<ToolSessionContext["room"]>,
  fileName: string,
  bytes: Buffer,
  fallbackName: string,
): Promise<string> {
  const directory = await roomFilesDir(ctx, room);
  const target = join(directory, safeFileName(fileName, fallbackName));
  const staging = `${target}.${randomUUID()}.part`;
  try {
    await writeFile(staging, bytes, { mode: 0o600 });
    await rename(staging, target);
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    throw error;
  }
  return relative(ctx.projectRoot, target);
}

async function saveStream(
  ctx: ToolSessionContext,
  room: NonNullable<ToolSessionContext["room"]>,
  fileName: string,
  body: NodeWebReadableStream<Uint8Array>,
  fallbackName: string,
): Promise<string> {
  const directory = await roomFilesDir(ctx, room);
  const target = join(directory, safeFileName(fileName, fallbackName));
  const staging = `${target}.${randomUUID()}.part`;
  try {
    await pipeline(Readable.fromWeb(body), createWriteStream(staging, { mode: 0o600 }));
    await rename(staging, target);
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    throw error;
  }
  return relative(ctx.projectRoot, target);
}
