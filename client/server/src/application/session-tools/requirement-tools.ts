import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { Locale, SuDuoToolConfirmationDto } from "@suduo/client-contracts";
import {
  formatRequirementNumber,
  parseRequirementNumberQuery,
  type AttachmentDto,
  type CommentSystemContent,
  type RequirementActivityEntryDto,
  type RequirementDetailDto,
} from "@suduo/cloud-contracts";
import { ApiError } from "../api-error.js";
import type { RequirementsRemoteClient } from "../../infrastructure/requirements-v2/remote-client.js";
import {
  TOOL_TEXT_LIMIT,
  failure,
  formatBytes,
  formatTime,
  textResult,
  toolFormat,
  type ToolFormat,
  type ToolResult,
} from "./format.js";
import {
  assertDirectoryInsideProject,
  materialsDir,
  replaceUnsafePathCharacters,
  readNotes,
  resolveRequirementDir,
  saveNotes,
  type RequirementDir,
} from "./requirement-dir.js";

/** 工具实现用到的远程接口（RequirementsRemoteClient 的子集，测试里可替换）。 */
export type RequirementToolsRemote = Pick<
  RequirementsRemoteClient,
  | "getRequirement"
  | "getRequirementByNumber"
  | "listComments"
  | "listAttachments"
  | "downloadAttachment"
  | "getCommentFile"
  | "downloadCommentFile"
  | "listRequirementActivity"
  | "createComment"
>;

/** 一次工具调用所在会话的上下文（由本机库派生，不信任模型给的需求 ID）。 */
export interface ToolSessionContext {
  sessionId: string;
  /** 会话的语言（迁移 017）：工具回包按它写。 */
  locale: Locale;
  projectRoot: string;
  remoteProjectId: string;
  /** 需求会话的需求；项目会话为 null。 */
  requirement: {
    remoteRequirementId: string;
    startVersion: number;
    /** 开工时刻：远程审计水位线的时间（有）或本机创建时间。 */
    startedAt: string;
    /** 开工时的远程审计水位线拿到了（known / empty）；没拿到时按本机开工时间判断，要在回答里写明。 */
    anchorKnown?: boolean;
  } | null;
  /**
   * 房间任务会话所在的房间（ADR-0009）；其他会话缺省。房间任务会话只能调 `allowedTools` 里的工具
   * （房间工具 + 需求房间的需求只读工具），不挂笔记与写工具。
   */
  room?: {
    roomId: string;
    roomName: string;
    agentId: string;
    allowedTools: readonly string[];
  };
  /** 委派出来的子会话（多 Agent 协作 S8）：不能再委派（深度 1，R2）。 */
  delegateChild?: boolean;
}

/** 图片直接交给模型看的上限；更大的存文件。 */
const INLINE_IMAGE_LIMIT = 8 * 1024 * 1024;
/** 文本类附件直接返回内容的上限。 */
const INLINE_TEXT_LIMIT = 64 * 1024;
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".log", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml",
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".java",
  ".kt", ".py", ".go", ".rs", ".sql", ".sh", ".properties", ".ini", ".toml",
]);
const COMMENT_PAGE_SIZE = "20";
/** 单条评论在结果里的上限；20 条 × 这个上限不会超过整体截断，翻页提示也放在最前面。 */
const COMMENT_BODY_PREVIEW = 1_500;
/** requirement_get 里正文的上限，超出存文件。 */
const INLINE_BODY_LIMIT = 8_000;
const INLINE_BODY_PREVIEW = 1_500;
/** 文本类附件直接返回的字数上限（字节在 64KB 内但字数太多时存文件）。 */
const INLINE_TEXT_CHARS = 10_000;
/** 笔记内联返回的上限；超出只给路径（低于整体截断，保证内联的一定是全文）。 */
const NOTES_INLINE_LIMIT = 10_000;
/** 「开工以后的变化」在结果里最多列多少条（最近的），其余只给条数。 */
const CHANGES_LIST_LIMIT = 30;
const ACTIVITY_PAGE_SIZE = "50";
/** 「开工以后的变化」最多翻几页活动（每页 50 条）。 */
const ACTIVITY_MAX_PAGES = 6;
const COMMENT_BODY_LIMIT = 4_000;

class ToolFailure extends Error {
  constructor(readonly result: ToolResult) {
    super("tool failure");
  }
}

export class RequirementTools {
  constructor(private readonly remote: RequirementToolsRemote) {}

  // ───────────────────────────── 只读工具 ─────────────────────────────

  async requirementGet(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.toolReply;
    return this.guard(f, async () => {
      const requirement = await this.target(ctx, args["number"]);
      const lines = [
        f.evidenceNote,
        "",
        `# ${f.requirementLabel(requirement)}`,
        text.get.status(
          f.statusLabel(requirement.status),
          f.priorityLabel(requirement.priority),
          f.userName(requirement.assignee),
          requirement.version,
        ) +
          (this.isCurrent(ctx, requirement) ? text.get.startVersion(ctx.requirement!.startVersion) : ""),
        text.get.created(
          f.userName(requirement.createdBy),
          formatTime(requirement.createdAt),
          f.userName(requirement.updatedBy),
          formatTime(requirement.updatedAt),
        ),
        text.get.counts(requirement.commentCount, requirement.attachmentCount),
      ];
      // 变化放在正文前面：正文再长，「开工以后的变化」也不会被截掉。
      if (this.isCurrent(ctx, requirement)) {
        lines.push("", text.get.changesHeading(formatTime(ctx.requirement!.startedAt)));
        if (ctx.requirement!.anchorKnown === false) {
          lines.push(text.get.anchorUnknown);
        }
        lines.push(...(await this.changesSince(requirement.id, ctx.requirement!.startedAt, ctx.locale)));
      }
      lines.push("", text.get.bodyHeading);
      const summary = requirement.summary;
      const budget = Math.min(INLINE_BODY_LIMIT, TOOL_TEXT_LIMIT - lines.join("\n").length - 200);
      if (summary.trim() === "") {
        lines.push(text.get.bodyEmpty);
      } else if (summary.length > budget) {
        const dir = materialsDir(await resolveRequirementDir(ctx.projectRoot, requirement));
        const saved = await this.saveText(f, dir, text.files.body(requirement.version), summary);
        lines.push(
          text.get.bodySaved(summary.length, saved),
          "",
          summary.slice(0, INLINE_BODY_PREVIEW),
          text.get.previewEllipsis,
        );
      } else {
        lines.push(summary);
      }
      return textResult(lines.join("\n"));
    });
  }

  async requirementComments(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.toolReply;
    return this.guard(f, async () => {
      const requirement = await this.target(ctx, args["number"]);
      const cursor = typeof args["cursor"] === "string" && args["cursor"] !== "" ? args["cursor"] : undefined;
      const page = await this.remote
        .listComments(requirement.id, { limit: COMMENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) })
        .catch((error: unknown) => {
          throw new ToolFailure(f.unavailable(text.what.comments(f.requirementLabel(requirement)), error));
        });
      if (page.items.length === 0 && cursor === undefined) {
        return textResult(text.comments.none(f.requirementLabel(requirement)));
      }
      const nextCursor = page.nextCursor ? page.nextCursor : null;
      const lines = [
        f.evidenceNote,
        "",
        text.comments.header(f.requirementLabel(requirement), page.items.length, nextCursor),
      ];
      page.items.forEach((comment, index) => {
        // 系统代写的评论按会话语言渲染；人写的评论原样。
        const content = commentText(comment, f);
        const body =
          content.length > COMMENT_BODY_PREVIEW
            ? content.slice(0, COMMENT_BODY_PREVIEW) + text.comments.clipped(content.length)
            : content;
        lines.push(
          "",
          `### ${index + 1}. ${f.userName(comment.author)} · ${formatTime(comment.createdAt)}` +
            (comment.artifactVersionId === null ? "" : text.comments.publishNote),
          body,
        );
        // 评论带的文件：给出编号，模型用 suduo_attachment_view 打开（规则同附件）。
        const files = comment.files ?? [];
        if (files.length > 0) {
          lines.push(
            text.comments.filesHeading(files.length),
            ...files.map((file) => `- ${file.id} · ${file.fileName} · ${file.contentType} · ${formatBytes(file.sizeBytes)}`),
          );
        }
      });
      lines.push("", text.comments.navigation(nextCursor));
      return textResult(lines.join("\n"));
    });
  }

  async requirementAttachments(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.toolReply;
    return this.guard(f, async () => {
      const requirement = await this.target(ctx, args["number"]);
      // 最新在前（需求附件评论文件与优先级 R1）：在这里排，连较早的需求服务（升序返回）也一样。
      const attachments = newestFirst(await this.attachmentsOf(f, requirement));
      if (attachments.length === 0) {
        return textResult(text.attachments.none(f.requirementLabel(requirement)));
      }
      return textResult(
        [
          text.attachments.header(f.requirementLabel(requirement), attachments.length),
          ...attachments.map(
            (item) =>
              `- ${item.id} · ${item.fileName} · ${item.contentType} · ${formatBytes(item.sizeBytes)} · ${f.userName(item.uploadedBy)} · ${formatTime(item.createdAt)}`,
          ),
        ].join("\n"),
      );
    });
  }

  async attachmentView(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.toolReply;
    return this.guard(f, async () => {
      const attachmentId = requireString(f, args["attachmentId"], "attachmentId");
      const requirement = await this.target(ctx, args["number"]);
      // 先在附件里找，找不到再看是不是这条需求的评论文件（需求附件评论文件与优先级 4.4）。
      const found = (await this.attachmentsOf(f, requirement)).find((item) => item.id === attachmentId);
      const attachment: ViewableFile | null = found
        ? { ...found, open: (signal) => this.remote.downloadAttachment(found.id, signal) }
        : await this.commentFileOf(f, requirement, attachmentId);
      if (!attachment) {
        return failure(text.attachments.notFound(f.requirementLabel(requirement), attachmentId));
      }
      const head = text.attachments.head(
        attachment.fileName,
        attachment.contentType,
        formatBytes(attachment.sizeBytes),
        f.userName(attachment.uploadedBy),
        formatTime(attachment.createdAt),
      );
      const kind = attachmentKind(attachment);
      if (kind === "image" && attachment.sizeBytes <= INLINE_IMAGE_LIMIT) {
        const bytes = await this.download(f, attachment);
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: head },
            { type: "inputImage", imageUrl: `data:${attachment.contentType};base64,${bytes.toString("base64")}` },
          ],
        };
      }
      if (kind === "text" && attachment.sizeBytes <= INLINE_TEXT_LIMIT) {
        const bytes = await this.download(f, attachment);
        const content = bytes.toString("utf8");
        if (content.length <= INLINE_TEXT_CHARS) {
          return textResult([head, f.evidenceNote, "", content].join("\n"));
        }
        const dir = materialsDir(await resolveRequirementDir(ctx.projectRoot, requirement));
        const saved = await this.saveText(f, dir, attachment.fileName, bytes);
        return textResult(`${head}\n${text.attachments.savedLong(saved)}`);
      }
      const dir = materialsDir(await resolveRequirementDir(ctx.projectRoot, requirement));
      const saved = await this.saveStream(
        f,
        () => attachment.open(AbortSignal.timeout(30 * 60_000)),
        dir,
        attachment.fileName,
      );
      return textResult(`${head}\n${text.attachments.saved(saved)}`);
    });
  }

  // ───────────────────────────── 结论笔记 ─────────────────────────────

  async notesRead(
    ctx: ToolSessionContext,
    args: Record<string, unknown>,
    remember: (requirementId: string, sha256: string | null) => void,
  ): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.toolReply;
    return this.guard(f, async () => {
      const requirement = await this.target(ctx, args["number"]);
      const dir = await resolveRequirementDir(ctx.projectRoot, requirement, { create: false });
      const notes = await readNotes(dir);
      remember(requirement.id, notes.sha256);
      if (notes.content === null || notes.content.trim() === "") {
        return textResult(text.notes.none(f.requirementLabel(requirement), notes.path));
      }
      if (notes.content.length > NOTES_INLINE_LIMIT) {
        // 内联会被截断，模型再「整篇写回」就会静默丢掉尾部：太长时只给路径，让模型读文件全文。
        return textResult(text.notes.tooLong(f.requirementLabel(requirement), notes.content.length, notes.path));
      }
      return textResult(`${text.notes.content(f.requirementLabel(requirement), notes.path)}\n\n${notes.content}`);
    });
  }

  async notesSave(
    ctx: ToolSessionContext,
    args: Record<string, unknown>,
    lastRead: (requirementId: string) => string | null | undefined,
    remember: (requirementId: string, sha256: string | null) => void,
  ): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.toolReply;
    return this.guard(f, async () => {
      const content = requireString(f, args["content"], "content");
      const requirement = await this.target(ctx, args["number"]);
      const dir = await resolveRequirementDir(ctx.projectRoot, requirement);
      const result = await saveNotes(dir, content, lastRead(requirement.id));
      remember(requirement.id, result.sha256);
      const lines = [text.notes.saved(f.requirementLabel(requirement), result.path)];
      if (result.backupPath) {
        lines.push(text.notes.backup(result.backupPath));
      }
      if (result.changedSinceRead) {
        lines.push(text.notes.changedSinceRead);
      }
      return textResult(lines.join("\n"));
    });
  }

  // ─────────────────────── 对外写工具（先预览，确认后执行） ───────────────────────

  /** 发评论的确认卡内容。只能发到会话自己的需求。 */
  async prepareComment(
    ctx: ToolSessionContext,
    args: Record<string, unknown>,
  ): Promise<SuDuoToolConfirmationDto | ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.toolReply;
    return this.guardPrepare(f, async () => {
      const body = typeof args["body"] === "string" ? args["body"].trim() : "";
      if (body === "") {
        return failure(text.write.commentEmpty);
      }
      if (body.length > COMMENT_BODY_LIMIT) {
        return failure(text.write.commentTooLong(COMMENT_BODY_LIMIT, body.length));
      }
      const requirement = await this.ownRequirement(ctx);
      return {
        tool: "comment_submit",
        requirement: confirmationRequirement(requirement),
        comment: { body },
        duplicateOf: null,
      };
    });
  }

  /** 用户确认后执行。写工具只剩发评论（确认版已停用）；历史上的发布确认卡不再执行。 */
  async executeWrite(ctx: ToolSessionContext, confirmation: SuDuoToolConfirmationDto): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.toolReply;
    if (confirmation.tool === "comment_submit") {
      const body = confirmation.comment?.body ?? "";
      try {
        const comment = await this.remote.createComment(confirmation.requirement.id, { body });
        return textResult(
          text.write.commentSent(
            confirmationLabel(f, confirmation),
            f.userName(comment.author),
            formatTime(comment.createdAt),
            comment.id,
          ),
        );
      } catch (error) {
        return writeFailure(f, "comment", error);
      }
    }
    return failure(text.write.incomplete);
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  private async guard(f: ToolFormat, work: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ToolFailure) {
        return error.result;
      }
      return f.unavailable(f.t.toolReply.what.neededInfo, error);
    }
  }

  private async guardPrepare(
    f: ToolFormat,
    work: () => Promise<SuDuoToolConfirmationDto | ToolResult>,
  ): Promise<SuDuoToolConfirmationDto | ToolResult> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ToolFailure) {
        return error.result;
      }
      return f.unavailable(f.t.toolReply.what.neededInfo, error);
    }
  }

  private isCurrent(ctx: ToolSessionContext, requirement: RequirementDetailDto): boolean {
    return ctx.requirement !== null && ctx.requirement.remoteRequirementId === requirement.id;
  }

  /** 解析目标需求：给了编号按编号查（限本项目）；没给就是会话自己的需求。 */
  private async target(ctx: ToolSessionContext, numberArg: unknown): Promise<RequirementDetailDto> {
    const f = toolFormat(ctx.locale);
    const text = f.t.toolReply;
    if (numberArg !== undefined && numberArg !== null && typeof numberArg !== "string" && typeof numberArg !== "number") {
      throw new ToolFailure(failure(text.args.numberType));
    }
    if (typeof numberArg === "number" || (typeof numberArg === "string" && numberArg.trim() !== "")) {
      const number = parseRequirementNumberQuery(String(numberArg));
      if (number === null) {
        throw new ToolFailure(failure(text.args.numberFormat(String(numberArg))));
      }
      return this.remote.getRequirementByNumber(ctx.remoteProjectId, number).catch((error: unknown) => {
        throw new ToolFailure(f.unavailable(text.what.requirement(formatRequirementNumber(number)), error));
      });
    }
    if (ctx.requirement === null) {
      throw new ToolFailure(failure(text.args.projectSession));
    }
    return this.remote.getRequirement(ctx.requirement.remoteRequirementId).catch((error: unknown) => {
      throw new ToolFailure(f.unavailable(text.what.currentRequirement, error));
    });
  }

  /** 写工具的目标只能是会话自己的需求，不接受模型给的编号（沿用旧规则）。 */
  private async ownRequirement(ctx: ToolSessionContext): Promise<RequirementDetailDto> {
    if (ctx.requirement === null) {
      throw new ToolFailure(failure(toolFormat(ctx.locale).t.toolReply.write.requirementSessionOnly));
    }
    return this.target(ctx, undefined);
  }

  private async attachmentsOf(f: ToolFormat, requirement: RequirementDetailDto): Promise<AttachmentDto[]> {
    const response = await this.remote.listAttachments(requirement.id).catch((error: unknown) => {
      throw new ToolFailure(f.unavailable(f.t.toolReply.what.attachmentList(f.requirementLabel(requirement)), error));
    });
    return response.items;
  }

  private async changesSince(requirementId: string, startedAt: string, locale: Locale): Promise<string[]> {
    const f = toolFormat(locale);
    const text = f.t.toolReply.changes;
    const since = Date.parse(startedAt);
    const entries: RequirementActivityEntryDto[] = [];
    let cursor: string | undefined;
    let complete = false;
    try {
      for (let page = 0; page < ACTIVITY_MAX_PAGES; page += 1) {
        const response = await this.remote.listRequirementActivity(requirementId, {
          limit: ACTIVITY_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        for (const entry of response.items) {
          if (Date.parse(entry.createdAt) <= since) {
            complete = true;
            break;
          }
          entries.push(entry);
        }
        if (complete || !response.nextCursor) {
          complete = true;
          break;
        }
        cursor = response.nextCursor;
      }
    } catch (error) {
      return [text.unavailable(f.reasonOf(error))];
    }
    if (entries.length === 0) {
      return [text.none];
    }
    const shown = entries.slice(0, CHANGES_LIST_LIMIT);
    const lines = [...shown]
      .reverse()
      .map((entry) => `- ${formatTime(entry.createdAt)} ${f.userName(entry.actor)} ${f.truncate(describeActivity(entry, locale), 200)}`);
    if (!complete || entries.length > shown.length) {
      lines.unshift(complete ? text.limited(entries.length, shown.length) : text.partial);
    }
    return lines;
  }

  private async download(f: ToolFormat, file: ViewableFile): Promise<Buffer> {
    const response = await file.open(AbortSignal.timeout(5 * 60_000)).catch((error: unknown) => {
      throw new ToolFailure(f.unavailable(f.t.toolReply.what.attachmentContent(file.fileName), error));
    });
    return Buffer.from(await response.arrayBuffer());
  }

  /** 这条需求的评论文件；不存在（404）或属于别的需求时为 null，其他失败是「查不到」。 */
  private async commentFileOf(f: ToolFormat, requirement: RequirementDetailDto, fileId: string): Promise<ViewableFile | null> {
    let file;
    try {
      file = await this.remote.getCommentFile(fileId);
    } catch (error) {
      if (error instanceof ApiError && (error.statusCode === 404 || error.statusCode === 400)) return null;
      throw new ToolFailure(f.unavailable(f.t.toolReply.what.attachmentContent(fileId), error));
    }
    if (file.requirementId !== requirement.id) return null;
    // 内联下载：云端按扩展名给出真实类型；不能内联的类型照常给字节。
    return { ...file, open: (signal) => this.remote.downloadCommentFile(file.id, { disposition: "inline", signal }) };
  }

  /** 流式下载到 `dir/fileName`（先写临时文件再改名，重复拉取直接覆盖）；返回相对项目目录的路径。 */
  private async saveStream(
    f: ToolFormat,
    open: () => Promise<Response>,
    dir: RequirementDir,
    fileName: string,
  ): Promise<string> {
    const text = f.t.toolReply;
    const safeName = safeFileName(fileName, text.files.fallbackName);
    await assertDirectoryInsideProject(dir.projectRoot, dir.absolutePath);
    await mkdir(dir.absolutePath, { recursive: true, mode: 0o700 });
    const target = join(dir.absolutePath, safeName);
    const staging = `${target}.${randomUUID()}.part`;
    const response = await open().catch((error: unknown) => {
      throw new ToolFailure(f.unavailable(text.what.file(fileName), error));
    });
    if (!response.body) {
      throw new ToolFailure(failure(text.files.empty(fileName)));
    }
    try {
      await pipeline(
        Readable.fromWeb(response.body as NodeWebReadableStream<Uint8Array>),
        createWriteStream(staging, { mode: 0o600 }),
      );
      await rename(staging, target);
    } catch (error) {
      await unlink(staging).catch(() => undefined);
      throw new ToolFailure(failure(text.files.saveFailed(fileName, f.reasonOf(error))));
    }
    return join(dir.relativePath, safeName);
  }

  /** 写一段文本到 `dir/fileName`（先写临时文件再改名）；返回相对项目目录的路径。 */
  private async saveText(f: ToolFormat, dir: RequirementDir, fileName: string, text: string | Buffer): Promise<string> {
    const safeName = safeFileName(fileName, f.t.toolReply.files.fallbackName);
    await assertDirectoryInsideProject(dir.projectRoot, dir.absolutePath);
    await mkdir(dir.absolutePath, { recursive: true, mode: 0o700 });
    const target = join(dir.absolutePath, safeName);
    const staging = `${target}.${randomUUID()}.part`;
    await writeFile(staging, text, { mode: 0o600 });
    await rename(staging, target);
    return join(dir.relativePath, safeName);
  }

}

/** 附件按上传时间从新到旧（同一时刻按 id 倒序，结果稳定）。 */
export function newestFirst<T extends { createdAt: string; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function confirmationRequirement(requirement: RequirementDetailDto): SuDuoToolConfirmationDto["requirement"] {
  return {
    id: requirement.id,
    projectId: requirement.projectId,
    number: requirement.number,
    title: requirement.title,
  };
}

function confirmationLabel(f: ToolFormat, confirmation: SuDuoToolConfirmationDto): string {
  const { number, title } = confirmation.requirement;
  return number === null
    ? f.t.toolReply.write.requirementTitleOnly(title ?? "")
    : f.requirementLabel({ number, title: title ?? "" });
}

/** 远程写失败：4xx 说明远程没接受；其他情况可能已经送达，提醒核对、不要重发。 */
function writeFailure(f: ToolFormat, kind: "comment", error: unknown): ToolResult {
  if (error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408) {
    return failure(f.t.toolReply.write.notSent(kind, f.reasonOf(error)));
  }
  return failure(f.t.toolReply.write.unconfirmed(kind, f.reasonOf(error)));
}

/**
 * 评论正文：系统代写的评论（契约 `CommentDto.system`）按会话语言渲染，不用存下的英文兜底正文；
 * 人写的评论、以及不认识的系统类型原样用正文。
 */
function commentText(comment: { body: string; system?: CommentSystemContent }, f: ToolFormat): string {
  const system = comment.system;
  if (system?.kind === "artifact_published") {
    return f.t.toolReply.comments.system.artifactPublished(system.params.versionNumber, system.params.fileCount);
  }
  if (system?.kind === "comment_files") {
    return f.t.toolReply.comments.system.commentFiles(system.params.fileCount);
  }
  return comment.body;
}

/** suduo_attachment_view 能打开的文件：需求附件或评论文件。 */
interface ViewableFile {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: AttachmentDto["uploadedBy"];
  createdAt: string;
  open(signal: AbortSignal): Promise<Response>;
}

/** 活动时间线条目的一句话描述（「把状态从 A 改成 B」），按会话的语言。 */
export function describeActivity(entry: RequirementActivityEntryDto, locale: Locale): string {
  const f = toolFormat(locale);
  const text = f.t.toolReply.activity;
  switch (entry.action) {
    case "requirement.created":
      return text.created;
    case "comment.created":
      return text.commented(f.truncate(entry.comment ? commentText(entry.comment, f).replace(/\s+/gu, " ") : "", 80));
    case "attachment.created":
      return text.attachmentAdded(entry.attachment?.fileName ?? "");
    case "attachment.deleted":
      return text.attachmentDeleted(entry.attachment?.fileName ?? "");
    case "artifact_version.published":
      return text.published(entry.artifactVersion?.versionNumber ?? "?", entry.artifactVersion?.fileCount ?? 0);
    default: {
      const parts = entry.changes.map((change) => {
        switch (change.field) {
          case "title":
            return text.titleChanged(change.from, change.to);
          case "summary":
            return text.summaryChanged;
          case "status":
            return text.statusChanged(f.statusLabel(change.from), f.statusLabel(change.to));
          case "assignee":
            return text.assigneeChanged(f.userName(change.from), f.userName(change.to));
          case "priority":
            return text.priorityChanged(f.priorityLabel(change.from), f.priorityLabel(change.to));
          default:
            return text.updated;
        }
      });
      return parts.length === 0 ? text.updated : text.join(parts);
    }
  }
}

function attachmentKind(attachment: Pick<AttachmentDto, "contentType" | "fileName">): "image" | "text" | "other" {
  const type = attachment.contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (INLINE_IMAGE_TYPES.has(type)) {
    return "image";
  }
  if (type.startsWith("text/") || type === "application/json" || type === "application/xml") {
    return "text";
  }
  const dot = attachment.fileName.lastIndexOf(".");
  const extension = dot >= 0 ? attachment.fileName.slice(dot).toLowerCase() : "";
  return TEXT_EXTENSIONS.has(extension) ? "text" : "other";
}

/** `fallback`：清理后为空时的兜底名，按会话语言（`toolReply.files.fallbackName`）。 */
function safeFileName(fileName: string, fallback: string): string {
  const cleaned = replaceUnsafePathCharacters(basename(fileName), "_").trim().replace(/[. ]+$/u, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return fallback;
  }
  // Windows 保留设备名（CON、NUL、COM1……）不能作文件名，前面加下划线。
  const stem = cleaned.split(".")[0]?.toUpperCase() ?? "";
  return /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/u.test(stem) ? `_${cleaned}` : cleaned;
}

function requireString(f: ToolFormat, value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolFailure(failure(f.t.toolReply.args.missing(name)));
  }
  return value;
}
