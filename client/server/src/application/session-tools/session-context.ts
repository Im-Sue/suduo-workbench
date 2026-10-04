import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Locale, RuntimeToolSpec, SessionContextDto } from "@suduo/client-contracts";
import {
  formatRequirementNumber,
  type ArtifactVersionDto,
  type AttachmentDto,
  type RequirementActivityEntryDto,
  type RequirementDetailDto,
} from "@suduo/cloud-contracts";
import { ApiError } from "../api-error.js";
import type { ProjectRepository } from "../../infrastructure/db/repositories/project-repository.js";
import type {
  RequirementAuditAnchor,
  RequirementSessionRefRecord,
  RequirementSessionRefRepository,
} from "../../infrastructure/db/repositories/requirement-session-ref-repository.js";
import type { SessionRepository } from "../../infrastructure/db/repositories/session-repository.js";
import type { WorkspaceMappingRepository } from "../../infrastructure/db/repositories/workspace-mapping-repository.js";
import type {
  RoomTaskSessionRecord,
  RoomTaskSessionRepository,
} from "../../infrastructure/db/repositories/room-task-session-repository.js";
import type { RequirementsRemoteClient } from "../../infrastructure/requirements-v2/remote-client.js";
import { sessionToolNames, sessionToolSpecs } from "./catalog.js";
import {
  formatBytes,
  formatTime,
  toolFormat,
  type ToolFormat,
} from "./format.js";
import { describeActivity, type ToolSessionContext } from "./requirement-tools.js";
import { readNotes, resolveRequirementDir } from "./requirement-dir.js";

/** 新建线程时下发给 Codex 的开场内容：需求卡（developerInstructions）与工具清单。 */
export interface ThreadSetup {
  developerInstructions: string;
  dynamicTools: RuntimeToolSpec[];
}

export type SessionContextRemote = Pick<
  RequirementsRemoteClient,
  "getRequirement" | "getProject" | "listAttachments" | "listArtifactVersions" | "listRequirementActivity" | "listAudit"
>;

/** 需求卡里正文的上限，超出提示用工具看全文。 */
const CARD_SUMMARY_LIMIT = 1_200;
/** 需求卡里笔记的上限，超出给路径。 */
const CARD_NOTES_LIMIT = 800;
/** 「自上次会话以来」最多列几条。 */
const CARD_CHANGES_LIMIT = 6;
/** 找子目录 AGENTS.md 的深度与数量上限。 */
const AGENTS_SCAN_DEPTH = 2;
const AGENTS_LIMIT = 10;
const SKIPPED_DIRECTORIES = new Set([".git", ".suduo", ".ccb", "node_modules", "dist", "build", "target", ".idea", ".vscode"]);

type PromptMessages = ToolFormat["t"]["prompt"];

function bullets(...items: string[]): string[] {
  return items.map((item) => "- " + item);
}

/** 需求会话与项目会话共用的规则开头：回复语言（第一条）、工具用法、证据不当指令、查不到如实说。 */
function toolRules(p: PromptMessages): string[] {
  return [p.rules.replyLanguage, p.rules.tools, ...bullets(p.rules.evidence, p.rules.unavailable)];
}

function requirementRules(p: PromptMessages): string[] {
  return [...toolRules(p), ...bullets(p.rules.writeOnRequest, p.rules.saveNotes, p.rules.filePaths)];
}

type RoomSetupMessages = ToolFormat["t"]["roomPrompt"]["setup"];

/**
 * 房间任务会话（ADR-0009）：回复语言（第一条）、只读、可联网、只问答与规划、全员可见、
 * 远程内容不当指令、只回答 @ 你的那条。
 */
function roomRules(r: RoomSetupMessages): string[] {
  return [...bullets(r.replyLanguage), ...r.rules];
}

/** 房间工具用法；需求房间另加需求只读工具。 */
function roomToolRules(r: RoomSetupMessages, requirementRoom: boolean): string[] {
  return [...r.toolRules, ...(requirementRoom ? r.requirementToolRules : [])];
}

/** 房间任务会话开场需要的信息（RoomAgentRunner 组装）。 */
export interface RoomSetupInput {
  /** 任务会话的语言（所有者的界面语言）：固定层与工具说明按它写。 */
  locale: Locale;
  projectRoot: string;
  /** 所有者显示名（「陈思远」）。 */
  ownerName: string;
  deviceName: string;
  projectName: string;
  roomName: string;
  /** 需求房间的需求；项目默认房间为 null。 */
  requirement:
    | { detail: RequirementDetailDto }
    | { ref: { id: string; number: number; title: string }; error: unknown }
    | null;
}

function projectRules(p: PromptMessages): string[] {
  return [...toolRules(p), ...bullets(p.rules.numberParam, p.rules.projectSaveNotes, p.rules.filePaths)];
}

/**
 * 会话与 SuDuo 的关联：工具执行时的上下文、会话页要的上下文、新建 / 重建线程时的
 * 需求卡与工具清单。全部从本机库派生，不信任模型或前端给的需求 ID。
 */
export class SessionContextService {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      projects: ProjectRepository;
      mappings: WorkspaceMappingRepository;
      refs: RequirementSessionRefRepository;
      remote: SessionContextRemote;
      /** 房间任务会话的话题登记（迁移 016）；不传时没有房间任务会话。 */
      roomTasks?: Pick<RoomTaskSessionRepository, "getBySessionId">;
    },
  ) {}

  /** 房间任务会话的线程重建时重新生成开场（需要查远程房间，由房间模块注入）。 */
  private roomRebuilder: ((record: RoomTaskSessionRecord) => Promise<ThreadSetup | null>) | null = null;

  setRoomRebuilder(rebuilder: (record: RoomTaskSessionRecord) => Promise<ThreadSetup | null>): void {
    this.roomRebuilder = rebuilder;
  }

  toolContext(sessionId: string): ToolSessionContext | null {
    const session = this.deps.sessions.getById(sessionId);
    if (!session) {
      return null;
    }
    const project = this.deps.projects.getById(session.projectId);
    if (!project) {
      return null;
    }
    const roomTask = this.deps.roomTasks?.getBySessionId(sessionId) ?? null;
    if (roomTask !== null) {
      // 房间任务会话（ADR-0009）：需求房间的「当前需求」用建会话时记下的版本与时刻。
      return {
        sessionId,
        locale: session.locale,
        projectRoot: project.rootPath,
        remoteProjectId: roomTask.remoteProjectId,
        requirement:
          roomTask.requirementId === null
            ? null
            : {
                remoteRequirementId: roomTask.requirementId,
                startVersion: roomTask.requirementVersion ?? 1,
                startedAt: new Date(roomTask.createdAt).toISOString(),
              },
        room: {
          roomId: roomTask.roomId,
          roomName: roomTask.roomName,
          agentId: roomTask.agentId,
          allowedTools: sessionToolNames(roomTask.requirementId === null ? "room" : "room_requirement"),
        },
      };
    }
    const ref = this.deps.refs.getBySessionId(sessionId);
    if (ref !== null) {
      return {
        sessionId,
        locale: session.locale,
        projectRoot: project.rootPath,
        remoteProjectId: ref.remoteProjectId,
        requirement: {
          remoteRequirementId: ref.remoteRequirementId,
          startVersion: ref.requirementVersion,
          startedAt: startedAtOf(ref),
          anchorKnown: ref.auditAnchor.state === "known" || ref.auditAnchor.state === "empty",
        },
      };
    }
    const mapping = this.deps.mappings.getByLocalProjectId(project.id);
    if (mapping === null) {
      return null;
    }
    return {
      sessionId,
      locale: session.locale,
      projectRoot: project.rootPath,
      remoteProjectId: mapping.remoteProjectId,
      requirement: null,
    };
  }

  describe(sessionId: string): SessionContextDto {
    const session = this.deps.sessions.getById(sessionId);
    if (!session) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    }
    const roomTask = this.deps.roomTasks?.getBySessionId(sessionId) ?? null;
    if (roomTask !== null) {
      return {
        sessionId,
        kind: roomTask.requirementId === null ? "project" : "requirement",
        contextMode: "tools",
        remoteProjectId: roomTask.remoteProjectId,
        requirement:
          roomTask.requirementId === null
            ? null
            : {
                remoteRequirementId: roomTask.requirementId,
                number: null,
                title: null,
                startVersion: roomTask.requirementVersion ?? 1,
                startedAt: roomTask.createdAt,
              },
      };
    }
    const ref = this.deps.refs.getBySessionId(sessionId);
    if (ref !== null) {
      return {
        sessionId,
        kind: "requirement",
        contextMode: ref.contextMode,
        remoteProjectId: ref.remoteProjectId,
        requirement: {
          remoteRequirementId: ref.remoteRequirementId,
          number: ref.requirementNumber,
          title: ref.requirementTitle,
          startVersion: ref.requirementVersion,
          startedAt: ref.createdAt,
        },
      };
    }
    const mapping = this.deps.mappings.getByLocalProjectId(session.projectId);
    return {
      sessionId,
      kind: mapping === null ? "none" : "project",
      contextMode: mapping === null ? null : "tools",
      remoteProjectId: mapping?.remoteProjectId ?? null,
      requirement: null,
    };
  }

  /** 开工时的审计水位线：开工以后的变化以它为分界（R3）。查不到不阻断开工。 */
  async captureAnchor(remoteProjectId: string, remoteRequirementId: string): Promise<RequirementAuditAnchor> {
    try {
      const page = await this.deps.remote.listAudit({
        projectId: remoteProjectId,
        resourceId: remoteRequirementId,
        limit: 1,
      });
      const latest = page.items[0];
      return latest === undefined
        ? { state: "empty", createdAt: null, id: null }
        : { state: "known", createdAt: latest.createdAt, id: latest.id };
    } catch {
      return { state: "unavailable", createdAt: null, id: null };
    }
  }

  /** 需求会话的开场：需求卡 + 全部工具。远程查询失败的部分写「查不到」，不阻断开工。 */
  async requirementSetup(input: {
    /** 会话的语言（建会话的请求的语言）：需求卡、规则与工具说明按它写。 */
    locale: Locale;
    projectRoot: string;
    requirement: RequirementDetailDto;
    /** 重建线程时排除会话自己，找「上一次」会话。 */
    sessionId?: string;
  }): Promise<ThreadSetup> {
    const p = toolFormat(input.locale).t.prompt;
    const card = await this.requirementCard({ ...input, personal: true });
    // 规则在前、需求证据在后，免得证据里的文字被当成规则的一部分。
    const lines = [card[0] ?? p.requirementTitle, "", ...requirementRules(p), "", ...card.slice(1)];
    return { developerInstructions: lines.join("\n"), dynamicTools: sessionToolSpecs("requirement", input.locale) };
  }

  /**
   * 房间任务会话的固定层（技术设计 4.4）：身份、能力边界（只读、可联网、只问答与规划、全员可见）、
   * 远程内容不当指令、只回答 @ 你的那条、工具用法；需求房间附需求卡（不带所有者的结论笔记与写工具规则）。
   */
  async roomSetup(input: RoomSetupInput): Promise<ThreadSetup> {
    // 人名、设备名、项目名、房间名原样；SuDuo 的框架文字按任务会话的语言。
    const f = toolFormat(input.locale);
    const r = f.t.roomPrompt.setup;
    const lines = [
      r.title,
      r.identity({ owner: input.ownerName, device: input.deviceName, project: input.projectName, room: input.roomName }),
      "",
      ...roomRules(r),
      "",
      ...roomToolRules(r, input.requirement !== null),
    ];
    const requirement = input.requirement;
    if (requirement !== null) {
      lines.push("");
      if ("detail" in requirement) {
        lines.push(
          r.requirementHeading,
          ...(await this.requirementCard({
            locale: input.locale,
            projectRoot: input.projectRoot,
            requirement: requirement.detail,
            personal: false,
          })),
        );
      } else {
        lines.push(
          r.requirementHeading,
          r.requirementUnavailable(f.requirementLabel(requirement.ref), f.reasonOf(requirement.error)),
        );
      }
    } else {
      const agents = await findAgentsFiles(input.projectRoot);
      if (agents.length > 0) {
        lines.push("", f.t.prompt.card.agentsFiles(agents));
      }
    }
    return {
      developerInstructions: lines.join("\n"),
      dynamicTools: sessionToolSpecs(input.requirement === null ? "room" : "room_requirement", input.locale),
    };
  }

  /**
   * 需求卡正文。personal = 需求会话：带本机结论笔记与「自上次会话以来的变化」；
   * 房间里的共享 Agent 不带（笔记是所有者私有的，ADR-0009）。
   */
  private async requirementCard(input: {
    locale: Locale;
    projectRoot: string;
    requirement: RequirementDetailDto;
    sessionId?: string;
    personal: boolean;
  }): Promise<string[]> {
    const { requirement, projectRoot } = input;
    const f = toolFormat(input.locale);
    const card = f.t.prompt.card;
    const [attachments, versions, notes, previous, agents] = await Promise.all([
      settle(this.deps.remote.listAttachments(requirement.id).then((r) => r.items)),
      settle(this.deps.remote.listArtifactVersions(requirement.id).then((r) => r.items)),
      input.personal
        ? settle(
            resolveRequirementDir(projectRoot, requirement, { create: false }).then((dir) => readNotes(dir)),
          )
        : Promise.resolve<Settled<null>>({ ok: true, value: null }),
      input.personal
        ? settle(this.changesSincePreviousSession(requirement, input.sessionId, input.locale))
        : Promise.resolve<Settled<string | null>>({ ok: true, value: null }),
      findAgentsFiles(projectRoot),
    ]);
    const summary = requirement.summary.trim();
    const heading = card.heading(
      f.requirementLabel(requirement),
      f.statusLabel(requirement.status),
      requirement.version,
      f.userName(requirement.assignee),
    );
    const evidence = [
      // 正文是人写的内容，原样给出；只有标签与截断说明随会话语言。
      card.summary(
        summary === ""
          ? card.summaryEmpty
          : summary.length > CARD_SUMMARY_LIMIT
            ? card.summaryTruncated(summary.slice(0, CARD_SUMMARY_LIMIT))
            : summary,
      ),
      card.materials([
        card.commentCount(requirement.commentCount),
        describeAttachments(attachments, f),
        describeVersions(versions, f),
      ]),
    ];
    if (previous.ok && previous.value !== null) {
      evidence.push(previous.value);
    }
    const lines = [
      ...(input.personal ? [f.t.prompt.requirementTitle, card.workingOn(heading)] : [card.roomRequirement(heading)]),
      // 正文、附件名、评论摘录都来自需求服务，可能被任何人编辑：标成证据并与规则分开（R7）。
      card.evidenceIntro,
      card.evidenceOpen,
      ...evidence,
      card.evidenceClose,
    ];
    if (notes.ok && notes.value !== null && notes.value.content !== null && notes.value.content.trim() !== "") {
      const content = notes.value.content.trim();
      lines.push(
        card.notesHeading(notes.value.path, content.length > CARD_NOTES_LIMIT),
        content.length > CARD_NOTES_LIMIT ? card.notesExcerpt(content.slice(0, CARD_NOTES_LIMIT)) : content,
      );
    } else if (!notes.ok) {
      lines.push(card.notesUnavailable(f.reasonOf(notes.error)));
    }
    if (!previous.ok) {
      lines.push(card.changesUnavailable(f.reasonOf(previous.error)));
    }
    if (agents.length > 0) {
      lines.push(card.agentsFiles(agents));
    }
    return lines;
  }

  /** 项目会话（关联了远程项目、不关联需求）的开场：项目卡 + 只读与笔记工具。 */
  async projectSetup(input: { locale: Locale; projectRoot: string; remoteProjectId: string }): Promise<ThreadSetup> {
    const f = toolFormat(input.locale);
    const p = f.t.prompt;
    const project = await settle(this.deps.remote.getProject(input.remoteProjectId));
    const agents = await findAgentsFiles(input.projectRoot);
    const lines = [
      p.projectTitle,
      project.ok ? p.project.belongsTo(project.value.name) : p.project.belongsToUnknown(f.reasonOf(project.error)),
    ];
    if (agents.length > 0) {
      lines.push(p.card.agentsFiles(agents));
    }
    lines.push("", ...projectRules(p));
    return { developerInstructions: lines.join("\n"), dynamicTools: sessionToolSpecs("project", input.locale) };
  }

  /**
   * 线程续接失败、重建全新线程时重新生成开场内容（新线程没有历史，必须重新给）。
   * 旧版需求会话与未关联项目的会话返回 null（旧版会话不补挂工具，保持原样）。
   */
  async rebuildSetup(sessionId: string): Promise<ThreadSetup | null> {
    const context = this.toolContext(sessionId);
    if (context === null) {
      return null;
    }
    const roomTask = this.deps.roomTasks?.getBySessionId(sessionId) ?? null;
    if (roomTask !== null) {
      // 房间任务会话：开场要查远程房间与需求，由房间模块生成；查不到就给最小的房间开场，工具照挂。
      const rebuilt = await this.roomRebuilder?.(roomTask).catch(() => null);
      if (rebuilt) {
        return rebuilt;
      }
      const r = toolFormat(context.locale).t.roomPrompt.setup;
      return {
        developerInstructions: [
          r.title,
          r.minimalIdentity(roomTask.roomName),
          "",
          ...roomRules(r),
          "",
          ...roomToolRules(r, roomTask.requirementId !== null),
        ].join("\n"),
        dynamicTools: sessionToolSpecs(roomTask.requirementId === null ? "room" : "room_requirement", context.locale),
      };
    }
    const ref = this.deps.refs.getBySessionId(sessionId);
    if (ref !== null) {
      if (ref.contextMode !== "tools") {
        // 旧版会话续接失败、要重建全新线程：新线程没有任何历史，给它需求卡与工具，此后按新版会话处理。
        this.deps.refs.markContextMode(sessionId, "tools");
      }
      try {
        const requirement = await this.deps.remote.getRequirement(ref.remoteRequirementId);
        return await this.requirementSetup({ locale: context.locale, projectRoot: context.projectRoot, requirement, sessionId });
      } catch (error) {
        // 需求查不到也要能继续对话：给一张最小的卡，工具照挂，模型可以自己再查。
        const f = toolFormat(context.locale);
        const p = f.t.prompt;
        return {
          developerInstructions: [
            p.requirementTitle,
            p.rebuildUnavailable(
              ref.requirementNumber === null ? null : formatRequirementNumber(ref.requirementNumber),
              ref.requirementTitle ?? "",
              f.reasonOf(error),
            ),
            "",
            ...requirementRules(p),
          ].join("\n"),
          dynamicTools: sessionToolSpecs("requirement", context.locale),
        };
      }
    }
    return this.projectSetup({ locale: context.locale, projectRoot: context.projectRoot, remoteProjectId: context.remoteProjectId });
  }

  /** 同一需求上一次会话以来的变化，一行概括 + 最多几条明细；没有上一次会话时为 null。 */
  private async changesSincePreviousSession(
    requirement: RequirementDetailDto,
    excludeSessionId: string | undefined,
    locale: Locale,
  ): Promise<string | null> {
    const previous = this.deps.refs.latestForRequirement(requirement.id, excludeSessionId);
    if (previous === null) {
      return null;
    }
    const since = Date.parse(startedAtOf(previous));
    const entries: RequirementActivityEntryDto[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const response = await this.deps.remote.listRequirementActivity(requirement.id, {
        limit: "50",
        ...(cursor ? { cursor } : {}),
      });
      let reachedStart = false;
      for (const entry of response.items) {
        if (Date.parse(entry.createdAt) <= since) {
          reachedStart = true;
          break;
        }
        entries.push(entry);
      }
      if (reachedStart || !response.nextCursor) {
        break;
      }
      cursor = response.nextCursor;
    }
    const f = toolFormat(locale);
    const changes = f.t.prompt.changes;
    const header = changes.header(formatTime(previous.createdAt), previous.requirementVersion);
    if (entries.length === 0) {
      return header + changes.none;
    }
    const recent = [...entries].reverse().slice(-CARD_CHANGES_LIMIT);
    return [
      header + changes.count(entries.length, CARD_CHANGES_LIMIT, entries.length > CARD_CHANGES_LIMIT),
      ...recent.map(
        (entry) => `- ${formatTime(entry.createdAt)} ${f.userName(entry.actor)} ${f.truncate(describeActivity(entry, locale), 120)}`,
      ),
    ].join("\n");
  }
}

function startedAtOf(ref: RequirementSessionRefRecord): string {
  return ref.auditAnchor.state === "known" && ref.auditAnchor.createdAt !== null
    ? ref.auditAnchor.createdAt
    : new Date(ref.createdAt).toISOString();
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function describeAttachments(result: Settled<AttachmentDto[]>, f: ToolFormat): string {
  const card = f.t.prompt.card;
  if (!result.ok) {
    return card.attachmentsUnavailable(f.reasonOf(result.error));
  }
  if (result.value.length === 0) {
    return card.noAttachments;
  }
  const shown = result.value
    .slice(0, 5)
    .map((item) => card.attachmentItem(item.fileName, kindLabel(item.contentType, card.kind), formatBytes(item.sizeBytes)));
  return card.attachments(result.value.length, shown, result.value.length > 5);
}

function describeVersions(result: Settled<ArtifactVersionDto[]>, f: ToolFormat): string {
  const card = f.t.prompt.card;
  if (!result.ok) {
    return card.versionsUnavailable(f.reasonOf(result.error));
  }
  if (result.value.length === 0) {
    return card.noVersions;
  }
  const latest = [...result.value].sort((a, b) => b.versionNumber - a.versionNumber)[0]!;
  return card.versions(result.value.length, latest.versionNumber, formatTime(latest.publishedAt));
}

function kindLabel(contentType: string, kind: PromptMessages["card"]["kind"]): string {
  if (contentType.startsWith("image/")) return kind.image;
  if (contentType.startsWith("video/")) return kind.video;
  if (contentType === "application/pdf") return kind.pdf;
  if (contentType.startsWith("text/")) return kind.text;
  return kind.file;
}

/**
 * 映射目录本身没有 AGENTS.md 时，Codex 不会去读子项目的；列出它们的位置让模型按需读。
 * 根目录有 AGENTS.md 时 Codex 自己会加载，返回空。
 */
async function findAgentsFiles(projectRoot: string): Promise<string[]> {
  const rootEntries = await readdir(projectRoot, { withFileTypes: true }).catch(() => []);
  if (rootEntries.some((entry) => entry.isFile() && entry.name === "AGENTS.md")) {
    return [];
  }
  const found: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > AGENTS_SCAN_DEPTH || found.length >= AGENTS_LIMIT) {
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= AGENTS_LIMIT) {
        return;
      }
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === "AGENTS.md" && depth > 0) {
        found.push(relative(projectRoot, path));
      } else if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
        await walk(path, depth + 1);
      }
    }
  };
  await walk(projectRoot, 0);
  return found.sort();
}
