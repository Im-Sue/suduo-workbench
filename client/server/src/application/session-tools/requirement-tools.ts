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
  type RequirementActivityEntryDto,
  type RequirementDetailDto,
} from "@suduo/cloud-contracts";
import { ApiError } from "../api-error.js";
import type { RequirementsRemoteClient } from "../../infrastructure/requirements-v2/remote-client.js";
import { guardExistingPath } from "../../infrastructure/workspace/path-guard.js";
import {
  EVIDENCE_NOTE,
  TOOL_TEXT_LIMIT,
  failure,
  formatBytes,
  formatTime,
  reasonOf,
  requirementLabel,
  statusLabel,
  textResult,
  truncate,
  unavailable,
  userName,
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
    return this.guard(async () => {
      const requirement = await this.target(ctx, args["number"]);
      const lines = [
        EVIDENCE_NOTE,
        "",
        `# ${requirementLabel(requirement)}`,
        `- 状态：${statusLabel(requirement.status, ctx.locale)}；负责人：${userName(requirement.assignee)}；当前版本：v${requirement.version}` +
          (this.isCurrent(ctx, requirement) ? `（开工时 v${ctx.requirement!.startVersion}）` : ""),
        `- 创建：${userName(requirement.createdBy)}，${formatTime(requirement.createdAt)}；最后修改：${userName(requirement.updatedBy)}，${formatTime(requirement.updatedAt)}`,
        `- 评论 ${requirement.commentCount} 条；附件 ${requirement.attachmentCount} 个（用 suduo_requirement_comments / suduo_requirement_attachments 查看）`,
      ];
      // 变化放在正文前面：正文再长，「开工以后的变化」也不会被截掉。
      if (this.isCurrent(ctx, requirement)) {
        lines.push("", `## 开工以后的变化（开工时刻 ${formatTime(ctx.requirement!.startedAt)}）`);
        if (ctx.requirement!.anchorKnown === false) {
          lines.push("- 注意：开工时没拿到需求服务的变化记录分界，下面按本机开工时间判断，前后几分钟内的变化可能有出入。");
        }
        lines.push(...(await this.changesSince(requirement.id, ctx.requirement!.startedAt, ctx.locale)));
      }
      lines.push("", "## 正文");
      const summary = requirement.summary;
      const budget = Math.min(INLINE_BODY_LIMIT, TOOL_TEXT_LIMIT - lines.join("\n").length - 200);
      if (summary.trim() === "") {
        lines.push("（正文为空）");
      } else if (summary.length > budget) {
        const dir = materialsDir(await resolveRequirementDir(ctx.projectRoot, requirement));
        const saved = await this.saveText(dir, `需求正文-v${requirement.version}.md`, summary);
        lines.push(
          `正文共 ${summary.length} 字，太长，全文已保存到 ${saved}，请直接读这个文件。开头部分：`,
          "",
          summary.slice(0, INLINE_BODY_PREVIEW),
          "……",
        );
      } else {
        lines.push(summary);
      }
      return textResult(lines.join("\n"));
    });
  }

  async requirementComments(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    return this.guard(async () => {
      const requirement = await this.target(ctx, args["number"]);
      const cursor = typeof args["cursor"] === "string" && args["cursor"] !== "" ? args["cursor"] : undefined;
      const page = await this.remote
        .listComments(requirement.id, { limit: COMMENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) })
        .catch((error: unknown) => {
          throw new ToolFailure(unavailable(`${requirementLabel(requirement)} 的评论`, error));
        });
      if (page.items.length === 0 && cursor === undefined) {
        return textResult(`${requirementLabel(requirement)} 还没有评论。`);
      }
      const navigation = page.nextCursor ? `还有下一页：cursor=${page.nextCursor}` : "这是最后一页。";
      const lines = [
        EVIDENCE_NOTE,
        "",
        `${requirementLabel(requirement)} 的评论（本页 ${page.items.length} 条；${navigation}）：`,
      ];
      page.items.forEach((comment, index) => {
        const body =
          comment.body.length > COMMENT_BODY_PREVIEW
            ? comment.body.slice(0, COMMENT_BODY_PREVIEW) + `……（这条评论共 ${comment.body.length} 字，后面省略；需要全文请让用户在需求页查看）`
            : comment.body;
        lines.push(
          "",
          `### ${index + 1}. ${userName(comment.author)} · ${formatTime(comment.createdAt)}` +
            (comment.artifactVersionId === null ? "" : "（确认版发布说明）"),
          body,
        );
      });
      lines.push("", navigation);
      return textResult(lines.join("\n"));
    });
  }

  async requirementAttachments(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    return this.guard(async () => {
      const requirement = await this.target(ctx, args["number"]);
      const attachments = await this.attachmentsOf(requirement);
      if (attachments.length === 0) {
        return textResult(`${requirementLabel(requirement)} 没有附件。`);
      }
      return textResult(
        [
          `${requirementLabel(requirement)} 的附件（${attachments.length} 个，用 suduo_attachment_view 查看内容）：`,
          ...attachments.map(
            (item) =>
              `- ${item.id} · ${item.fileName} · ${item.contentType} · ${formatBytes(item.sizeBytes)} · ${userName(item.uploadedBy)} · ${formatTime(item.createdAt)}`,
          ),
        ].join("\n"),
      );
    });
  }

  async attachmentView(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    return this.guard(async () => {
      const attachmentId = requireString(args["attachmentId"], "attachmentId");
      const requirement = await this.target(ctx, args["number"]);
      const attachment = (await this.attachmentsOf(requirement)).find((item) => item.id === attachmentId);
      if (!attachment) {
        return failure(
          `${requirementLabel(requirement)} 的附件里没有 ID 为 ${attachmentId} 的附件（可能已删除，或属于别的需求）。先用 suduo_requirement_attachments 看附件清单。`,
        );
      }
      const head = `附件 ${attachment.fileName}（${attachment.contentType}，${formatBytes(attachment.sizeBytes)}，${userName(attachment.uploadedBy)} 上传于 ${formatTime(attachment.createdAt)}）`;
      const kind = attachmentKind(attachment);
      if (kind === "image" && attachment.sizeBytes <= INLINE_IMAGE_LIMIT) {
        const bytes = await this.download(attachment.id, attachment.fileName);
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: head },
            { type: "inputImage", imageUrl: `data:${attachment.contentType};base64,${bytes.toString("base64")}` },
          ],
        };
      }
      if (kind === "text" && attachment.sizeBytes <= INLINE_TEXT_LIMIT) {
        const bytes = await this.download(attachment.id, attachment.fileName);
        const text = bytes.toString("utf8");
        if (text.length <= INLINE_TEXT_CHARS) {
          return textResult([head, EVIDENCE_NOTE, "", text].join("\n"));
        }
        const dir = materialsDir(await resolveRequirementDir(ctx.projectRoot, requirement));
        const saved = await this.saveText(dir, attachment.fileName, bytes);
        return textResult(`${head}\n内容较长，已保存到项目内 ${saved}，请直接读取这个文件。`);
      }
      const dir = materialsDir(await resolveRequirementDir(ctx.projectRoot, requirement));
      const saved = await this.saveStream(
        () => this.remote.downloadAttachment(attachment.id, AbortSignal.timeout(30 * 60_000)),
        dir,
        attachment.fileName,
      );
      return textResult(`${head}\n已保存到项目内 ${saved}，可以直接读取这个文件。`);
    });
  }

  async artifactVersions(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    return this.guard(async () => {
      const requirement = await this.target(ctx, args["number"]);
      const versions = await this.remote.listArtifactVersions(requirement.id).catch((error: unknown) => {
        throw new ToolFailure(unavailable(`${requirementLabel(requirement)} 的确认版`, error));
      });
      if (versions.items.length === 0) {
        return textResult(`${requirementLabel(requirement)} 还没有发布过确认版。`);
      }
      const lines = [`${requirementLabel(requirement)} 的确认版（${versions.items.length} 个，最新在前）：`];
      const ordered = [...versions.items].sort((a, b) => b.versionNumber - a.versionNumber);
      for (const version of ordered.slice(0, 10)) {
        lines.push("", `## v${version.versionNumber} · ${userName(version.publishedBy)} · ${formatTime(version.publishedAt)}（${version.fileCount} 个文件）`);
        const detail = await this.remote.getArtifactVersion(version.id).catch(() => null);
        if (detail === null) {
          lines.push("- 文件清单查不到（需求服务暂时不可用），可以稍后再查。");
        } else {
          lines.push(...detail.files.map((file) => `- ${file.fileName}（${formatBytes(file.sizeBytes)}）`));
        }
      }
      if (ordered.length > 10) {
        lines.push("", `另有 ${ordered.length - 10} 个更早的版本未列出。`);
      }
      lines.push("", "要读文件内容，用 suduo_artifact_fetch 把某个版本保存到本地。");
      return textResult(lines.join("\n"));
    });
  }

  async artifactFetch(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    return this.guard(async () => {
      const versionNumber = Number(args["version"]);
      if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
        return failure("version 必须是正整数，例如 2。");
      }
      const requirement = await this.target(ctx, args["number"]);
      const versions = await this.remote.listArtifactVersions(requirement.id).catch((error: unknown) => {
        throw new ToolFailure(unavailable(`${requirementLabel(requirement)} 的确认版`, error));
      });
      const version = versions.items.find((item) => item.versionNumber === versionNumber);
      if (!version) {
        const existing = versions.items.map((item) => `v${item.versionNumber}`).join("、") || "无";
        return failure(`${requirementLabel(requirement)} 没有确认版 v${versionNumber}（现有：${existing}）。`);
      }
      const detail: ArtifactVersionDetailDto = await this.remote.getArtifactVersion(version.id).catch((error: unknown) => {
        throw new ToolFailure(unavailable(`确认版 v${versionNumber} 的文件清单`, error));
      });
      const base = materialsDir(await resolveRequirementDir(ctx.projectRoot, requirement));
      const dir = childDir(base, `确认版-v${versionNumber}`);
      const saved: string[] = [];
      const usedNames = new Set<string>();
      for (const file of detail.files) {
        saved.push(
          await this.saveStream(
            () => this.remote.downloadArtifactVersionFile(version.id, file.id, AbortSignal.timeout(30 * 60_000)),
            dir,
            uniqueName(file.fileName, usedNames),
          ),
        );
      }
      return textResult(
        [
          `已把 ${requirementLabel(requirement)} 的确认版 v${versionNumber}（${userName(version.publishedBy)}，${formatTime(version.publishedAt)}）保存到 ${dir.relativePath}/：`,
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
    return this.guard(async () => {
      const requirement = await this.target(ctx, args["number"]);
      const dir = await resolveRequirementDir(ctx.projectRoot, requirement, { create: false });
      const notes = await readNotes(dir);
      remember(requirement.id, notes.sha256);
      if (notes.content === null || notes.content.trim() === "") {
        return textResult(`${requirementLabel(requirement)} 在本机还没有结论笔记（${notes.path}）。`);
      }
      if (notes.content.length > NOTES_INLINE_LIMIT) {
        // 内联会被截断，模型再「整篇写回」就会静默丢掉尾部：太长时只给路径，让模型读文件全文。
        return textResult(
          `${requirementLabel(requirement)} 的结论笔记共 ${notes.content.length} 字，太长，不在这里显示。` +
            `请直接读取文件 ${notes.path} 的全文；更新时在全文基础上整理后用 suduo_notes_save 整篇写回。`,
        );
      }
      return textResult(`${requirementLabel(requirement)} 的结论笔记（${notes.path}）：\n\n${notes.content}`);
    });
  }

  async notesSave(
    ctx: ToolSessionContext,
    args: Record<string, unknown>,
    lastRead: (requirementId: string) => string | null | undefined,
    remember: (requirementId: string, sha256: string | null) => void,
  ): Promise<ToolResult> {
    return this.guard(async () => {
      const content = requireString(args["content"], "content");
      const requirement = await this.target(ctx, args["number"]);
      const dir = await resolveRequirementDir(ctx.projectRoot, requirement);
      const result = await saveNotes(dir, content, lastRead(requirement.id));
      remember(requirement.id, result.sha256);
      const lines = [`已更新 ${requirementLabel(requirement)} 的结论笔记：${result.path}（只在本机，不会自动共享）。`];
      if (result.backupPath) {
        lines.push(`旧内容已存档：${result.backupPath}`);
      }
      if (result.changedSinceRead) {
        lines.push(
          "注意：在你上次读取之后，笔记被用户或其他会话改过；旧内容已存档。请告诉用户，并确认这次写入没有丢掉对方新加的内容。",
        );
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
    return this.guardPrepare(async () => {
      const body = typeof args["body"] === "string" ? args["body"].trim() : "";
      if (body === "") {
        return failure("评论内容不能为空。");
      }
      if (body.length > COMMENT_BODY_LIMIT) {
        return failure(`评论最多 ${COMMENT_BODY_LIMIT} 字，现在是 ${body.length} 字，请精简后再发。`);
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
    return this.guardPrepare(async () => {
      const paths = stringArray(args["paths"]);
      const attachmentIds = stringArray(args["attachmentIds"]);
      if (paths.length === 0 && attachmentIds.length === 0) {
        return failure("至少给出一个要发布的文件：paths（项目里的文件）或 attachmentIds（已有附件）。");
      }
      const requirement = await this.ownRequirement(ctx);
      const files: NonNullable<SuDuoToolConfirmationDto["publish"]>["files"] = [];
      for (const path of paths) {
        const guarded = await guardExistingPath(ctx.projectRoot, path).catch(() => null);
        const info = guarded ? await stat(guarded.absolutePath).catch(() => null) : null;
        if (!guarded || !info?.isFile()) {
          return failure(`项目里找不到文件 ${path}（路径要相对项目目录，且必须是文件）。`);
        }
        files.push({ name: basename(guarded.absolutePath), sizeBytes: info.size, source: "path", ref: guarded.relativePath });
      }
      if (attachmentIds.length > 0) {
        const attachments = await this.attachmentsOf(requirement);
        for (const id of attachmentIds) {
          const attachment = attachments.find((item) => item.id === id);
          if (!attachment) {
            return failure(`${requirementLabel(requirement)} 的附件里没有 ID 为 ${id} 的附件。`);
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
    if (confirmation.tool === "comment_submit") {
      const body = confirmation.comment?.body ?? "";
      try {
        const comment = await this.remote.createComment(confirmation.requirement.id, { body });
        return textResult(
          `已发出评论到 ${confirmationLabel(confirmation)}（${userName(comment.author)}，${formatTime(comment.createdAt)}，评论 ID ${comment.id}）。`,
        );
      } catch (error) {
        return writeFailure("评论", error);
      }
    }
    const publish = confirmation.publish;
    if (!publish) {
      return failure("确认卡内容不完整，没有执行。");
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
          changedAfterConfirm.push(`${file.ref}（确认时 ${formatBytes(file.sizeBytes)}，发布时 ${formatBytes(current.size)}）`);
        }
        const attachmentId = await this.uploadProjectFile(ctx, confirmation.requirement.id, file.ref);
        attachmentIds.push(attachmentId);
        uploaded.push(`${file.name}（附件 ID ${attachmentId}）`);
      }
      const version = await this.remote.publishArtifactVersion(confirmation.requirement.id, {
        operationKey,
        attachmentIds,
        ...(publish.note === null ? {} : { note: publish.note }),
      });
      return textResult(
        `已发布 ${confirmationLabel(confirmation)} 的确认版 v${version.versionNumber}（${version.fileCount} 个文件，${formatTime(version.publishedAt)}）。` +
          (changedAfterConfirm.length === 0
            ? ""
            : `\n注意：这些文件在用户确认之后又被改过，发布的是最新内容，请告诉用户：${changedAfterConfirm.join("；")}。`),
      );
    } catch (error) {
      const result = error instanceof ToolFailure ? error.result : writeFailure("确认版", error);
      if (uploaded.length === 0) {
        return result;
      }
      // 部分文件已经上传成需求附件：说清楚，免得用户重试时再传一遍（ADR-0004：告知现状与选项）。
      return failure(
        `${textOfResult(result)}\n已经上传成需求附件、但确认版没有发布的文件：${uploaded.join("；")}。` +
          "这些附件留在需求上；重试时可以把它们的附件 ID 放进 attachmentIds 直接发布，不用重新上传。",
      );
    }
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  private async guard(work: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ToolFailure) {
        return error.result;
      }
      return unavailable("需要的信息", error);
    }
  }

  private async guardPrepare(
    work: () => Promise<SuDuoToolConfirmationDto | ToolResult>,
  ): Promise<SuDuoToolConfirmationDto | ToolResult> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ToolFailure) {
        return error.result;
      }
      return unavailable("需要的信息", error);
    }
  }

  private isCurrent(ctx: ToolSessionContext, requirement: RequirementDetailDto): boolean {
    return ctx.requirement !== null && ctx.requirement.remoteRequirementId === requirement.id;
  }

  /** 解析目标需求：给了编号按编号查（限本项目）；没给就是会话自己的需求。 */
  private async target(ctx: ToolSessionContext, numberArg: unknown): Promise<RequirementDetailDto> {
    if (numberArg !== undefined && numberArg !== null && typeof numberArg !== "string" && typeof numberArg !== "number") {
      throw new ToolFailure(failure("参数 number 应为需求编号，例如 \"REQ-12\" 或 12。"));
    }
    if (typeof numberArg === "number" || (typeof numberArg === "string" && numberArg.trim() !== "")) {
      const number = parseRequirementNumberQuery(String(numberArg));
      if (number === null) {
        throw new ToolFailure(failure(`需求编号「${numberArg}」格式不对，应为 REQ-12 或 12。`));
      }
      return this.remote.getRequirementByNumber(ctx.remoteProjectId, number).catch((error: unknown) => {
        throw new ToolFailure(unavailable(`需求 ${formatRequirementNumber(number)}`, error));
      });
    }
    if (ctx.requirement === null) {
      throw new ToolFailure(failure("这是项目会话，没有关联需求：请在参数 number 里给出需求编号，例如 REQ-12。"));
    }
    return this.remote.getRequirement(ctx.requirement.remoteRequirementId).catch((error: unknown) => {
      throw new ToolFailure(unavailable("当前需求", error));
    });
  }

  /** 写工具的目标只能是会话自己的需求，不接受模型给的编号（沿用旧规则）。 */
  private async ownRequirement(ctx: ToolSessionContext): Promise<RequirementDetailDto> {
    if (ctx.requirement === null) {
      throw new ToolFailure(failure("只有从需求创建的会话才能发评论或发布确认版。"));
    }
    return this.target(ctx, undefined);
  }

  private async attachmentsOf(requirement: RequirementDetailDto): Promise<AttachmentDto[]> {
    const response = await this.remote.listAttachments(requirement.id).catch((error: unknown) => {
      throw new ToolFailure(unavailable(`${requirementLabel(requirement)} 的附件清单`, error));
    });
    return response.items;
  }

  private async changesSince(requirementId: string, startedAt: string, locale: Locale): Promise<string[]> {
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
      return [`- 查不到开工以后的变化：${reasonOf(error)}。这不代表没有变化。`];
    }
    if (entries.length === 0) {
      return ["- 开工以后没有变化。"];
    }
    const shown = entries.slice(0, CHANGES_LIST_LIMIT);
    const lines = [...shown].reverse().map((entry) => `- ${formatTime(entry.createdAt)} ${userName(entry.actor)} ${truncate(describeActivity(entry, locale), 200)}`);
    if (!complete || entries.length > shown.length) {
      lines.unshift(
        complete
          ? `- （共 ${entries.length} 处变化，只列出最近 ${shown.length} 处）`
          : "- （变化较多，只列出最近的部分）",
      );
    }
    return lines;
  }

  private async download(attachmentId: string, fileName: string): Promise<Buffer> {
    const response = await this.remote.downloadAttachment(attachmentId, AbortSignal.timeout(5 * 60_000)).catch((error: unknown) => {
      throw new ToolFailure(unavailable(`附件 ${fileName} 的内容`, error));
    });
    return Buffer.from(await response.arrayBuffer());
  }

  /** 流式下载到 `dir/fileName`（先写临时文件再改名，重复拉取直接覆盖）；返回相对项目目录的路径。 */
  private async saveStream(
    open: () => Promise<Response>,
    dir: RequirementDir,
    fileName: string,
  ): Promise<string> {
    const safeName = safeFileName(fileName);
    await assertDirectoryInsideProject(dir.projectRoot, dir.absolutePath);
    await mkdir(dir.absolutePath, { recursive: true, mode: 0o700 });
    const target = join(dir.absolutePath, safeName);
    const staging = `${target}.${randomUUID()}.part`;
    const response = await open().catch((error: unknown) => {
      throw new ToolFailure(unavailable(`文件 ${fileName}`, error));
    });
    if (!response.body) {
      throw new ToolFailure(failure(`查不到文件 ${fileName}：需求服务返回了空内容。`));
    }
    try {
      await pipeline(
        Readable.fromWeb(response.body as NodeWebReadableStream<Uint8Array>),
        createWriteStream(staging, { mode: 0o600 }),
      );
      await rename(staging, target);
    } catch (error) {
      await unlink(staging).catch(() => undefined);
      throw new ToolFailure(failure(`文件 ${fileName} 没有保存成功：${reasonOf(error)}。`));
    }
    return join(dir.relativePath, safeName);
  }

  /** 写一段文本到 `dir/fileName`（先写临时文件再改名）；返回相对项目目录的路径。 */
  private async saveText(dir: RequirementDir, fileName: string, text: string | Buffer): Promise<string> {
    const safeName = safeFileName(fileName);
    await assertDirectoryInsideProject(dir.projectRoot, dir.absolutePath);
    await mkdir(dir.absolutePath, { recursive: true, mode: 0o700 });
    const target = join(dir.absolutePath, safeName);
    const staging = `${target}.${randomUUID()}.part`;
    await writeFile(staging, text, { mode: 0o600 });
    await rename(staging, target);
    return join(dir.relativePath, safeName);
  }

  private async uploadProjectFile(ctx: ToolSessionContext, requirementId: string, relativePath: string): Promise<string> {
    const guarded = await guardExistingPath(ctx.projectRoot, relativePath).catch(() => {
      throw new ToolFailure(failure(`项目里的文件 ${relativePath} 找不到了（可能在确认之后被移动或删除），确认版没有发布。`));
    });
    const size = (await stat(guarded.absolutePath)).size;
    const form = new FormData();
    form.set("file", await openAsBlob(guarded.absolutePath), basename(guarded.absolutePath));
    // 借 Request 生成 multipart 正文与边界，文件按需从磁盘读，不整个读进内存。
    const request = new Request("http://suduo.local/upload", { method: "POST", body: form });
    const contentType = request.headers.get("content-type");
    if (!request.body || !contentType) {
      throw new Error("无法生成上传内容");
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

function confirmationLabel(confirmation: SuDuoToolConfirmationDto): string {
  const { number, title } = confirmation.requirement;
  return number === null ? `需求「${title ?? ""}」` : `${formatRequirementNumber(number)}「${title ?? ""}」`;
}

/** 远程写失败：4xx 说明远程没接受；其他情况可能已经送达，提醒核对、不要重发。 */
function writeFailure(what: "评论" | "确认版", error: unknown): ToolResult {
  if (error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408) {
    return failure(`未能发出${what}：${reasonOf(error)}。`);
  }
  return failure(
    `${what}的发送结果未确认：${reasonOf(error)}。请让用户到需求页核对是否已经发出，不要直接重发。`,
  );
}

/** 活动时间线条目的一句话描述（「把状态从 A 改成 B」），按会话的语言。 */
export function describeActivity(entry: RequirementActivityEntryDto, locale: Locale): string {
  switch (entry.action) {
    case "requirement.created":
      return "创建了需求";
    case "comment.created":
      return `发了评论：「${truncate(entry.comment?.body.replace(/\s+/gu, " ") ?? "", 80)}」`;
    case "attachment.created":
      return `上传了附件 ${entry.attachment?.fileName ?? ""}`;
    case "attachment.deleted":
      return `删除了附件 ${entry.attachment?.fileName ?? ""}`;
    case "artifact_version.published":
      return `发布了确认版 v${entry.artifactVersion?.versionNumber ?? "?"}（${entry.artifactVersion?.fileCount ?? 0} 个文件）`;
    default: {
      const parts = entry.changes.map((change) => {
        switch (change.field) {
          case "title":
            return `把标题从「${change.from}」改成「${change.to}」`;
          case "summary":
            return "修改了正文（当前正文见上方）";
          case "status":
            return `把状态从「${statusLabel(change.from, locale)}」改成「${statusLabel(change.to, locale)}」`;
          case "assignee":
            return `把负责人从「${userName(change.from)}」改成「${userName(change.to)}」`;
          default:
            return "修改了需求";
        }
      });
      return parts.length === 0 ? "修改了需求" : parts.join("，");
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
function uniqueName(fileName: string, used: Set<string>): string {
  let candidate = safeFileName(fileName);
  const dot = candidate.lastIndexOf(".");
  const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
  const extension = dot > 0 ? candidate.slice(dot) : "";
  for (let index = 2; used.has(candidate); index += 1) {
    candidate = `${stem} (${index})${extension}`;
  }
  used.add(candidate);
  return candidate;
}

function safeFileName(fileName: string): string {
  const cleaned = replaceUnsafePathCharacters(basename(fileName), "_").trim().replace(/[. ]+$/u, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return "附件";
  }
  // Windows 保留设备名（CON、NUL、COM1……）不能作文件名，前面加下划线。
  const stem = cleaned.split(".")[0]?.toUpperCase() ?? "";
  return /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/u.test(stem) ? `_${cleaned}` : cleaned;
}

function textOfResult(result: ToolResult): string {
  return result.contentItems.map((item) => (item.type === "inputText" ? item.text : "")).join("\n");
}


function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolFailure(failure(`缺少参数 ${name}。`));
  }
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
    : [];
}
