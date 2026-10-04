import { randomUUID } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { Locale, SuDuoToolConfirmationDto } from "@suduo/client-contracts";
import {
  formatRequirementNumber,
  parseRequirementNumberQuery,
  type ArtifactVersionDetailDto,
  type AttachmentDto,
  type CommentSystemContent,
  type RequirementActivityEntryDto,
  type RequirementDetailDto,
} from "@suduo/cloud-contracts";
import { ApiError } from "../api-error.js";
import type { RequirementsRemoteClient } from "../../infrastructure/requirements-v2/remote-client.js";
import { guardExistingPath } from "../../infrastructure/workspace/path-guard.js";
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
  childDir,
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
  | "listArtifactVersions"
  | "getArtifactVersion"
  | "downloadArtifactVersionFile"
  | "listRequirementActivity"
  | "createComment"
  | "uploadAttachment"
  | "publishArtifactVersion"
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
        text.get.status(f.statusLabel(requirement.status), f.userName(requirement.assignee), requirement.version) +
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
      const attachments = await this.attachmentsOf(f, requirement);
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
      const attachment = (await this.attachmentsOf(f, requirement)).find((item) => item.id === attachmentId);
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
        const bytes = await this.download(f, attachment.id, attachment.fileName);
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: head },
            { type: "inputImage", imageUrl: `data:${attachment.contentType};base64,${bytes.toString("base64")}` },
          ],
        };
      }
      if (kind === "text" && attachment.sizeBytes <= INLINE_TEXT_LIMIT) {
        const bytes = await this.download(f, attachment.id, attachment.fileName);
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
        () => this.remote.downloadAttachment(attachment.id, AbortSignal.timeout(30 * 60_000)),
        dir,
        attachment.fileName,
      );
      return textResult(`${head}\n${text.attachments.saved(saved)}`);
    });
  }

  async artifactVersions(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.toolReply;
    return this.guard(f, async () => {
      const requirement = await this.target(ctx, args["number"]);
      const versions = await this.remote.listArtifactVersions(requirement.id).catch((error: unknown) => {
        throw new ToolFailure(f.unavailable(text.what.confirmedVersions(f.requirementLabel(requirement)), error));
      });
      if (versions.items.length === 0) {
        return textResult(text.artifacts.none(f.requirementLabel(requirement)));
      }
      const lines = [text.artifacts.header(f.requirementLabel(requirement), versions.items.length)];
      const ordered = [...versions.items].sort((a, b) => b.versionNumber - a.versionNumber);
      for (const version of ordered.slice(0, 10)) {
        lines.push(
          "",
          text.artifacts.version(
            version.versionNumber,
            f.userName(version.publishedBy),
            formatTime(version.publishedAt),
            version.fileCount,
          ),
        );
        const detail = await this.remote.getArtifactVersion(version.id).catch(() => null);
        if (detail === null) {
          lines.push(text.artifacts.filesUnavailable);
        } else {
          lines.push(...detail.files.map((file) => text.artifacts.file(file.fileName, formatBytes(file.sizeBytes))));
        }
      }
      if (ordered.length > 10) {
        lines.push("", text.artifacts.more(ordered.length - 10));
      }
      lines.push("", text.artifacts.fetchHint);
      return textResult(lines.join("\n"));
    });
  }

  async artifactFetch(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.toolReply;
    return this.guard(f, async () => {
      const versionNumber = Number(args["version"]);
      if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
        return failure(text.artifacts.invalidVersion);
      }
      const requirement = await this.target(ctx, args["number"]);
      const versions = await this.remote.listArtifactVersions(requirement.id).catch((error: unknown) => {
        throw new ToolFailure(f.unavailable(text.what.confirmedVersions(f.requirementLabel(requirement)), error));
      });
      const version = versions.items.find((item) => item.versionNumber === versionNumber);
      if (!version) {
        const existing = versions.items.map((item) => `v${item.versionNumber}`);
        return failure(text.artifacts.noSuchVersion(f.requirementLabel(requirement), versionNumber, existing));
      }
      const detail: ArtifactVersionDetailDto = await this.remote.getArtifactVersion(version.id).catch((error: unknown) => {
        throw new ToolFailure(f.unavailable(text.what.versionFiles(versionNumber), error));
      });
      const base = materialsDir(await resolveRequirementDir(ctx.projectRoot, requirement));
      const dir = childDir(base, text.files.confirmedVersionDir(versionNumber));
      const saved: string[] = [];
      const usedNames = new Set<string>();
      for (const file of detail.files) {
        saved.push(
          await this.saveStream(
            f,
            () => this.remote.downloadArtifactVersionFile(version.id, file.id, AbortSignal.timeout(30 * 60_000)),
            dir,
            uniqueName(file.fileName, usedNames, text.files.fallbackName),
          ),
        );
      }
      return textResult(
        [
          text.artifacts.fetched(
            f.requirementLabel(requirement),
            versionNumber,
            f.userName(version.publishedBy),
            formatTime(version.publishedAt),
            dir.relativePath,
          ),
          ...saved.map((path) => `- ${path}`),
        ].join("\n"),
      );
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

  /** 发布确认版的确认卡内容：项目文件逐个检查存在，已有附件逐个对上 ID。 */
  async preparePublish(
    ctx: ToolSessionContext,
    args: Record<string, unknown>,
  ): Promise<SuDuoToolConfirmationDto | ToolResult> {
    const f = toolFormat(ctx.locale);
    const text = f.t.toolReply;
    return this.guardPrepare(f, async () => {
      const paths = stringArray(args["paths"]);
      const attachmentIds = stringArray(args["attachmentIds"]);
      if (paths.length === 0 && attachmentIds.length === 0) {
        return failure(text.write.noFiles);
      }
      const requirement = await this.ownRequirement(ctx);
      const files: NonNullable<SuDuoToolConfirmationDto["publish"]>["files"] = [];
      for (const path of paths) {
        const guarded = await guardExistingPath(ctx.projectRoot, path).catch(() => null);
        const info = guarded ? await stat(guarded.absolutePath).catch(() => null) : null;
        if (!guarded || !info?.isFile()) {
          return failure(text.write.fileNotFound(path));
        }
        files.push({ name: basename(guarded.absolutePath), sizeBytes: info.size, source: "path", ref: guarded.relativePath });
      }
      if (attachmentIds.length > 0) {
        const attachments = await this.attachmentsOf(f, requirement);
        for (const id of attachmentIds) {
          const attachment = attachments.find((item) => item.id === id);
          if (!attachment) {
            return failure(text.write.attachmentNotFound(f.requirementLabel(requirement), id));
          }
          files.push({ name: attachment.fileName, sizeBytes: attachment.sizeBytes, source: "attachment", ref: attachment.id });
        }
      }
      const note = typeof args["note"] === "string" && args["note"].trim() !== "" ? args["note"].trim() : null;
      return {
        tool: "artifact_publish",
        requirement: confirmationRequirement(requirement),
        publish: { files, note },
        duplicateOf: null,
      };
    });
  }

  /** 用户确认后执行。`operationKey` 用审批 ID，重放不会多发确认版。 */
  async executeWrite(
    ctx: ToolSessionContext,
    confirmation: SuDuoToolConfirmationDto,
    operationKey: string,
  ): Promise<ToolResult> {
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
    const publish = confirmation.publish;
    if (!publish) {
      return failure(text.write.incomplete);
    }
    const uploaded: string[] = [];
    try {
      const attachmentIds: string[] = [];
      const changedAfterConfirm: string[] = [];
      for (const file of publish.files) {
        if (file.source === "attachment") {
          attachmentIds.push(file.ref);
          continue;
        }
        // 确认之后文件又被改过：照常发布用户确认的这个文件的当前内容，但在结果里说清（ADR-0004：检测并告知）。
        const current = await stat(join(ctx.projectRoot, file.ref)).catch(() => null);
        if (current !== null && file.sizeBytes !== null && current.size !== file.sizeBytes) {
          changedAfterConfirm.push(text.write.changedFile(file.ref, formatBytes(file.sizeBytes), formatBytes(current.size)));
        }
        const attachmentId = await this.uploadProjectFile(f, ctx, confirmation.requirement.id, file.ref);
        attachmentIds.push(attachmentId);
        uploaded.push(text.write.uploadedFile(file.name, attachmentId));
      }
      const version = await this.remote.publishArtifactVersion(confirmation.requirement.id, {
        operationKey,
        attachmentIds,
        ...(publish.note === null ? {} : { note: publish.note }),
      });
      return textResult(
        text.write.published(
          confirmationLabel(f, confirmation),
          version.versionNumber,
          version.fileCount,
          formatTime(version.publishedAt),
        ) + (changedAfterConfirm.length === 0 ? "" : text.write.changedAfterConfirm(changedAfterConfirm)),
      );
    } catch (error) {
      const result = error instanceof ToolFailure ? error.result : writeFailure(f, "artifact", error);
      if (uploaded.length === 0) {
        return result;
      }
      // 部分文件已经上传成需求附件：说清楚，免得用户重试时再传一遍（ADR-0004：告知现状与选项）。
      return failure(`${textOfResult(result)}${text.write.uploadedNotPublished(uploaded)}`);
    }
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

  private async download(f: ToolFormat, attachmentId: string, fileName: string): Promise<Buffer> {
    const response = await this.remote.downloadAttachment(attachmentId, AbortSignal.timeout(5 * 60_000)).catch((error: unknown) => {
      throw new ToolFailure(f.unavailable(f.t.toolReply.what.attachmentContent(fileName), error));
    });
    return Buffer.from(await response.arrayBuffer());
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

  private async uploadProjectFile(
    f: ToolFormat,
    ctx: ToolSessionContext,
    requirementId: string,
    relativePath: string,
  ): Promise<string> {
    const guarded = await guardExistingPath(ctx.projectRoot, relativePath).catch(() => {
      throw new ToolFailure(failure(f.t.toolReply.write.projectFileMissing(relativePath)));
    });
    const size = (await stat(guarded.absolutePath)).size;
    const form = new FormData();
    form.set("file", await openAsBlob(guarded.absolutePath), basename(guarded.absolutePath));
    // 借 Request 生成 multipart 正文与边界，文件按需从磁盘读，不整个读进内存。
    const request = new Request("http://suduo.local/upload", { method: "POST", body: form });
    const contentType = request.headers.get("content-type");
    if (!request.body || !contentType) {
      // 不变式：正常走不到（FormData 总能生成正文），开发者报错直接写英文。
      throw new Error("Couldn't build the upload body");
    }
    const response = await this.remote.uploadAttachment({
      requirementId,
      body: request.body as unknown as AsyncIterable<Uint8Array>,
      contentType,
      attachmentSize: String(size),
      idempotencyKey: randomUUID(),
      signal: AbortSignal.timeout(30 * 60_000),
    });
    return response.attachment.id;
  }
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
function writeFailure(f: ToolFormat, kind: "comment" | "artifact", error: unknown): ToolResult {
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
  return comment.body;
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
          default:
            return text.updated;
        }
      });
      return parts.length === 0 ? text.updated : text.join(parts);
    }
  }
}

function attachmentKind(attachment: AttachmentDto): "image" | "text" | "other" {
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

/** 同一批里重名的文件改成「名字 (2).扩展名」，不互相覆盖。 */
function uniqueName(fileName: string, used: Set<string>, fallback: string): string {
  let candidate = safeFileName(fileName, fallback);
  const dot = candidate.lastIndexOf(".");
  const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
  const extension = dot > 0 ? candidate.slice(dot) : "";
  for (let index = 2; used.has(candidate); index += 1) {
    candidate = `${stem} (${index})${extension}`;
  }
  used.add(candidate);
  return candidate;
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

function textOfResult(result: ToolResult): string {
  return result.contentItems.map((item) => (item.type === "inputText" ? item.text : "")).join("\n");
}


function requireString(f: ToolFormat, value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolFailure(failure(f.t.toolReply.args.missing(name)));
  }
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
    : [];
}
