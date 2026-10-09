import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { formatRequirementNumber } from "@suduo/cloud-contracts";
import { messagesFor, type ServerMessages } from "../../i18n/messages/index.js";
import type { EventRepository } from "../../infrastructure/db/repositories/event-repository.js";
import type { RequirementSessionRefRepository } from "../../infrastructure/db/repositories/requirement-session-ref-repository.js";
import type { SessionReferenceRepository } from "../../infrastructure/db/repositories/session-reference-repository.js";
import type { SessionRecord, SessionRepository } from "../../infrastructure/db/repositories/session-repository.js";
import { assertWritableInsideProject, ensureSuDuoDir, SUDUO_DIR } from "../../infrastructure/workspace/suduo-dir.js";
import { failure, formatTime, textResult, TOOL_TEXT_LIMIT, type ToolResult } from "../session-tools/format.js";
import type { ToolSessionContext } from "../session-tools/requirement-tools.js";
import type { WorkspaceChanges, WorkspaceDiff } from "../workspace-service.js";
import { redactSecrets } from "../session-activity.js";
import { lineDiff } from "./line-diff.js";
import { changedPaths, isSecretFile, projectRounds, type ProjectedRound, type ProjectableEvent } from "./session-projection.js";

/**
 * 跨会话读取（多 Agent 协作 S7，技术设计 2.8、需求 4.1 / R8 / R10）：`session_list` / `session_read` 两个工具的实现。
 *
 * - 可读范围：这台电脑上的普通会话（任意 Agent）；房间任务（ADR-0009）、已删除的、读取方自己不可读。
 * - 分层：summary（概要）→ conversation（最近几轮问答）→ turns（回合列表）→ turn（某回合细节）→ changes（累计改动）。
 *   内容从账本按统一条目模型投影（与 Agent 无关）；超过单次工具结果上限的整份存到读取方项目的
 *   `.suduo/sessions/` 下并返回路径（ADR-0003），回包只给开头。
 * - 留痕：每次读取记一条 `session_references`；再读同一个会话时说明「上次读取后又有 N 个新回合」。
 */
export interface SessionReaderDependencies {
  sessions: Pick<SessionRepository, "getById" | "listByProject" | "listReadable">;
  events: Pick<EventRepository, "listBackfill" | "maxSeq">;
  references: Pick<SessionReferenceRepository, "record" | "lastRead">;
  requirementRefs: Pick<RequirementSessionRefRepository, "getBySessionId">;
  /** 会话的工作区改动（相对会话基线）；没有时「改动」退回 Agent 报告的文件改动。 */
  workspace?: {
    hasBaseline(sessionId: string): Promise<boolean>;
    listChanges(sessionId: string): Promise<WorkspaceChanges>;
    diff(sessionId: string, path: string): Promise<WorkspaceDiff>;
  };
  /** Agent 的产品名（配置表）；不认识的原样。 */
  agentName(agentId: string): string;
  /**
   * 这个会话属于另一个需求服务（另一个账号 / 团队）：不列、不读（需求 4.1「同一个 SuDuo 账号下的本机会话」）。
   * 没给时都算同一个。
   */
  otherAccount?(sessionId: string): boolean;
  now?: () => number;
}

export const SESSION_READ_VIEWS = ["summary", "conversation", "turns", "turn", "changes"] as const;
export type SessionReadView = (typeof SESSION_READ_VIEWS)[number];

/** 概要里最终回答的上限（字符）。 */
const SUMMARY_ANSWER_CHARS = 3_000;
/** 对话层每轮：用户消息与回答各自的上限。 */
const ROUND_USER_CHARS = 2_000;
const ROUND_ANSWER_CHARS = 6_000;
const TURNS_PAGE = 50;
const LIST_DEFAULT = 20;
const LIST_MAX = 50;
const SUMMARY_FILES = 30;
/** 回合细节里单条命令输出、工具结果的上限。 */
const DETAIL_OUTPUT_CHARS = 1_500;
/** 改动层最多列多少个文件的 diff（其余只给文件名，完整的在 SuDuo 的改动面板）。 */
const MAX_DIFF_FILES = 60;
const EVENT_PAGE = 500;
/** 回合投影的缓存（按会话与账本序号；同一会话连着读几层不必每次回放）。 */
const ROUND_CACHE_SIZE = 8;

export class SessionReaderService {
  private readonly roundCache = new Map<string, { seq: number; rounds: ProjectedRound[] }>();

  constructor(private readonly deps: SessionReaderDependencies) {}

  /** `session_list`：可读的其他会话，按最近活动。 */
  list(ctx: ToolSessionContext, args: Record<string, unknown>): ToolResult {
    const r = messagesFor(ctx.locale).sessionContext.reply;
    const reader = this.deps.sessions.getById(ctx.sessionId);
    const scope = args["scope"] === "all" ? "all" : "project";
    const limit = clampInteger(args["limit"], LIST_DEFAULT, 1, LIST_MAX);
    const query = typeof args["query"] === "string" ? args["query"].trim().toLowerCase() : "";
    const candidates =
      scope === "all" || reader === null ? this.deps.sessions.listReadable(500) : this.deps.sessions.listByProject(reader.projectId);
    const readable = candidates.filter(
      (session) =>
        session.id !== ctx.sessionId &&
        session.kind === "normal" &&
        session.state !== "deleted" &&
        this.deps.otherAccount?.(session.id) !== true &&
        (query === "" || session.title.toLowerCase().includes(query)),
    );
    if (readable.length === 0) return textResult(r.listEmpty);
    const shown = readable.slice(0, limit);
    const lines = [r.listHeader(r.listScope[scope] ?? scope, shown.length)];
    for (const session of shown) {
      lines.push(r.listLine(session.id, session.title, this.describe(session, r, { rounds: null }).join(" · ")));
    }
    if (readable.length > shown.length) lines.push(r.listMore);
    return textResult(lines.join("\n"));
  }

  /** `session_read`：分层读取另一个会话，并记下这次读取。 */
  async read(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const r = messagesFor(ctx.locale).sessionContext.reply;
    const targetId = typeof args["sessionId"] === "string" ? args["sessionId"].trim().toLowerCase() : "";
    if (targetId === "") return failure(r.sessionIdMissing);
    const rawView = args["view"] === undefined ? "summary" : String(args["view"]);
    if (!isView(rawView)) return failure(r.viewInvalid(rawView));
    const target = this.deps.sessions.getById(targetId);
    const refusal = this.refusal(targetId, target, r);
    if (refusal !== null || target === null) return failure(refusal ?? r.notFound(targetId));

    const targetSeq = this.deps.events.maxSeq(targetId);
    const previous = this.deps.references.lastRead(ctx.sessionId, targetId);
    const rounds = this.rounds(targetId, targetSeq);
    const body = await this.render(target, rounds, rawView, args, r);
    if (!("text" in body)) return body;
    this.deps.references.record({ readerSessionId: ctx.sessionId, targetId, view: rawView, targetSeq, now: this.now() });

    const lines = [r.evidenceNote, r.header(target.title, this.describe(target, r, { rounds: rounds.length }).join(" · ")), r.sessionId(target.id)];
    // 读自己也行（线程重建后 Agent 不记得之前的对话时，这是恢复的办法），注明一句。
    if (target.id === ctx.sessionId) lines.push(r.selfNote);
    if (previous !== null) {
      const fresh = rounds.filter((round) => round.seq > previous.targetSeq).length;
      if (fresh > 0) lines.push(r.sinceLastRead(fresh));
    }
    const text = [lines.join("\n"), "", body.text, "", r.evidenceEnd].join("\n");
    return textResult(await this.fitOrSave(ctx, target, rawView, args, text, r));
  }

  /** 一个会话的全部回合（只读账本里回放用的紧凑事件，不看流式增量）。 */
  rounds(sessionId: string, throughSeq = this.deps.events.maxSeq(sessionId)): ProjectedRound[] {
    const cached = this.roundCache.get(sessionId);
    if (cached !== undefined && cached.seq === throughSeq) return cached.rounds;
    const events: ProjectableEvent[] = [];
    let after = 0;
    for (;;) {
      const page = this.deps.events.listBackfill(sessionId, after, throughSeq, EVENT_PAGE);
      events.push(...page);
      if (page.length < EVENT_PAGE) break;
      after = page[page.length - 1]!.seq;
    }
    const rounds = projectRounds(events);
    this.roundCache.delete(sessionId);
    this.roundCache.set(sessionId, { seq: throughSeq, rounds });
    while (this.roundCache.size > ROUND_CACHE_SIZE) this.roundCache.delete(this.roundCache.keys().next().value!);
    return rounds;
  }

  private refusal(targetId: string, target: SessionRecord | null, r: Reply): string | null {
    if (target === null) return r.notFound(targetId);
    if (target.kind === "room_task") return r.roomTask;
    if (target.state === "deleted") return r.deleted;
    if (this.deps.otherAccount?.(target.id) === true) return r.otherAccount;
    return null;
  }

  /** 「Claude Code · REQ-12「标题」 · 进行中 · 共 5 个回合 · 最后活动 …」 */
  private describe(session: SessionRecord, r: Reply, options: { rounds: number | null }): string[] {
    const parts = [this.deps.agentName(session.agentId)];
    const requirement = this.deps.requirementRefs.getBySessionId(session.id);
    if (requirement !== null && requirement.requirementNumber !== null) {
      parts.push(formatRequirementNumber(requirement.requirementNumber));
    }
    parts.push(r.sessionState[session.state] ?? session.state);
    if (options.rounds !== null) parts.push(r.rounds(options.rounds));
    const activity = session.lastActivityAt ?? session.updatedAt;
    parts.push(r.lastActivity(formatTime(activity)));
    return parts;
  }

  private async render(
    target: SessionRecord,
    rounds: ProjectedRound[],
    view: SessionReadView,
    args: Record<string, unknown>,
    r: Reply,
  ): Promise<{ text: string } | ToolResult> {
    switch (view) {
      case "summary":
        return { text: await this.summary(target, rounds, r) };
      case "conversation":
        return { text: conversation(rounds, clampInteger(args["rounds"], 3, 1, 10), r) };
      case "turns":
        return { text: turnList(rounds, clampInteger(args["page"], 1, 1, Number.MAX_SAFE_INTEGER), r) };
      case "turn": {
        const index = integerOf(args["turn"]);
        if (index === null) return failure(r.turnMissing);
        const round = rounds[index - 1];
        if (round === undefined) return failure(r.turnNotFound(index, rounds.length));
        return { text: turnDetail(round, r) };
      }
      case "changes":
        return { text: await this.changes(target, rounds, r) };
    }
  }

  private async summary(target: SessionRecord, rounds: ProjectedRound[], r: Reply): Promise<string> {
    const lines: string[] = [];
    if (rounds.length === 0) {
      lines.push(r.noRounds);
    } else {
      const answered = [...rounds].reverse().find((round) => round.answer !== null);
      if (answered === undefined) {
        lines.push(r.noAnswer);
      } else {
        lines.push(r.finalAnswer(answered.index), clip(answered.answer!, SUMMARY_ANSWER_CHARS, r));
      }
    }
    lines.push("");
    const workspace = await this.workspaceChanges(target);
    if (workspace !== null) {
      lines.push(r.changedFiles);
      if (workspace.items.length === 0) lines.push(r.noChanges);
      for (const item of workspace.items.slice(0, SUMMARY_FILES)) {
        lines.push(r.fileLine(item.path, r.fileKind[item.kind] ?? item.kind, item.additions, item.deletions));
      }
      if (workspace.items.length > SUMMARY_FILES) lines.push(r.moreFiles(workspace.items.length - SUMMARY_FILES));
    } else {
      const reported = [...changedPaths(rounds)];
      lines.push(r.reportedFiles);
      if (reported.length === 0) lines.push(r.noChanges);
      for (const [path, kind] of reported.slice(0, SUMMARY_FILES)) lines.push(r.fileLine(path, r.fileKind[kind] ?? kind, null, null));
      if (reported.length > SUMMARY_FILES) lines.push(r.moreFiles(reported.length - SUMMARY_FILES));
    }
    lines.push("", r.nextViews);
    return lines.join("\n");
  }

  private async changes(target: SessionRecord, rounds: ProjectedRound[], r: Reply): Promise<string> {
    const workspace = await this.workspaceChanges(target);
    if (workspace !== null && this.deps.workspace !== undefined) {
      const lines = [r.changesHeader(workspace.items.length, workspace.additions, workspace.deletions)];
      if (workspace.items.length === 0) lines.push(r.noChanges);
      // 整份不截（放不下时 fitOrSave 整份存文件）；文件太多时只列前面的，其余给文件名。
      for (const item of workspace.items.slice(0, MAX_DIFF_FILES)) {
        const diff = await this.deps.workspace.diff(target.id, item.path).catch(() => null);
        lines.push("");
        if (diff === null || diff.truncated) {
          lines.push(r.fileLine(item.path, r.fileKind[item.kind] ?? item.kind, item.additions, item.deletions), r.binary);
          continue;
        }
        const result = lineDiff(item.path, diff.before, diff.after);
        if (result.coarse) lines.push(r.coarseDiff);
        lines.push(isSecretFile(item.path) ? redactSecrets(result.text) : result.text);
      }
      for (const item of workspace.items.slice(MAX_DIFF_FILES)) {
        lines.push(r.fileLine(item.path, r.fileKind[item.kind] ?? item.kind, item.additions, item.deletions));
      }
      if (workspace.items.length > MAX_DIFF_FILES) lines.push(r.moreDiffFiles(workspace.items.length - MAX_DIFF_FILES));
      return lines.join("\n");
    }
    // 没有工作区基线（老会话）：用各回合 Agent 报告的改动。
    const lines = [r.changesFallback];
    const files = rounds.flatMap((round) => round.files);
    if (files.length === 0) lines.push(r.noChanges);
    for (const file of files) {
      lines.push("", file.diff === "" ? r.fileLine(file.path, r.fileKind[file.kind] ?? file.kind, null, null) : file.diff.trimEnd());
    }
    return lines.join("\n");
  }

  private async workspaceChanges(target: SessionRecord): Promise<WorkspaceChanges | null> {
    const workspace = this.deps.workspace;
    if (workspace === undefined) return null;
    try {
      if (!(await workspace.hasBaseline(target.id))) return null;
      return await workspace.listChanges(target.id);
    } catch {
      return null;
    }
  }

  /** 放得下就原样；放不下就整份存到读取方项目的 `.suduo/sessions/`，回包给路径与开头。 */
  private async fitOrSave(
    ctx: ToolSessionContext,
    target: SessionRecord,
    view: SessionReadView,
    args: Record<string, unknown>,
    text: string,
    r: Reply,
  ): Promise<string> {
    if (text.length <= TOOL_TEXT_LIMIT) return text;
    try {
      const directory = join(ctx.projectRoot, SUDUO_DIR, "sessions", target.id.slice(0, 8));
      await ensureSuDuoDir(ctx.projectRoot);
      await assertWritableInsideProject(ctx.projectRoot, directory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const name =
        view === "turn"
          ? `turn-${String(integerOf(args["turn"]) ?? 0)}.md`
          : view === "changes"
            ? "changes.diff"
            : view === "turns"
              ? `turns-page-${String(integerOf(args["page"]) ?? 1)}.md`
              : view === "conversation"
                ? `conversation-${String(integerOf(args["rounds"]) ?? 3)}.md`
                : `${view}.md`;
      const file = join(directory, name);
      const staging = `${file}.${randomUUID()}.part`;
      try {
        await writeFile(staging, text, { mode: 0o600 });
        await rename(staging, file);
      } catch (error) {
        await unlink(staging).catch(() => undefined);
        throw error;
      }
      const head = r.saved(text.length, relative(ctx.projectRoot, file));
      return [head, "", text.slice(0, TOOL_TEXT_LIMIT - head.length - 200)].join("\n");
    } catch {
      // 存不了（目录只读等）：退回截断，至少给出开头。
      return text;
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

type Reply = ServerMessages["sessionContext"]["reply"];

function conversation(rounds: ProjectedRound[], count: number, r: Reply): string {
  if (rounds.length === 0) return r.noRounds;
  const recent = rounds.slice(-count);
  const lines = [r.conversationHeader(recent.length, rounds.length)];
  for (const round of recent) {
    lines.push("", r.roundHeader(round.index, r.roundStatus[round.status], formatTime(round.startedAt)));
    lines.push(r.user, round.userText === "" ? r.emptyMessage : clip(round.userText, ROUND_USER_CHARS, r));
    if (round.attachmentCount > 0) lines.push(r.attachments(round.attachmentCount));
    lines.push(r.agent, round.answer === null ? r.noAnswer : clip(round.answer, ROUND_ANSWER_CHARS, r));
    if (round.error !== null) lines.push(r.error(round.error));
  }
  return lines.join("\n");
}

function turnList(rounds: ProjectedRound[], page: number, r: Reply): string {
  if (rounds.length === 0) return r.noRounds;
  // 第 1 页是最新的 50 个；页内按时间先后。
  const end = Math.max(0, rounds.length - (page - 1) * TURNS_PAGE);
  const start = Math.max(0, end - TURNS_PAGE);
  const slice = rounds.slice(start, end);
  if (slice.length === 0) return r.pageEmpty(page, Math.ceil(rounds.length / TURNS_PAGE));
  const lines = [r.turnsHeader(slice[0]!.index, slice[slice.length - 1]!.index, rounds.length)];
  for (const round of slice) {
    const first = round.userText.split("\n").find((line) => line.trim() !== "")?.trim() ?? r.emptyMessage;
    lines.push(r.turnLine(round.index, r.roundStatus[round.status], formatTime(round.startedAt), oneLine(first, 120)));
  }
  if (start > 0) lines.push(r.turnsMore(page + 1));
  return lines.join("\n");
}

function turnDetail(round: ProjectedRound, r: Reply): string {
  const lines = [r.roundHeader(round.index, r.roundStatus[round.status], formatTime(round.startedAt))];
  lines.push(r.user, round.userText === "" ? r.emptyMessage : round.userText);
  if (round.attachmentCount > 0) lines.push(r.attachments(round.attachmentCount));
  const empty = round.commands.length === 0 && round.tools.length === 0 && round.files.length === 0 && round.webSearches.length === 0;
  if (round.commands.length > 0) {
    lines.push("", r.commands);
    for (const command of round.commands) {
      lines.push(`$ ${command.command}${command.exitCode === null ? "" : r.exitCode(command.exitCode)}`);
      if (command.output.trim() !== "") lines.push(r.output, clip(command.output.trimEnd(), DETAIL_OUTPUT_CHARS, r));
    }
  }
  if (round.tools.length > 0) {
    lines.push("", r.tools);
    for (const tool of round.tools) {
      lines.push(`- ${tool.name}${tool.arguments === "" ? "" : ` ${clip(tool.arguments, 300, r)}`}`);
      if (tool.output.trim() !== "") lines.push(`  ${r.toolResult(tool.success)} ${clip(tool.output.trim(), DETAIL_OUTPUT_CHARS, r)}`);
    }
  }
  if (round.webSearches.length > 0) {
    lines.push("", r.webSearches, ...round.webSearches.map((query) => `- ${query}`));
  }
  if (round.files.length > 0) {
    lines.push("", r.files);
    for (const file of round.files) {
      lines.push(file.diff === "" ? r.fileLine(file.path, r.fileKind[file.kind] ?? file.kind, null, null) : file.diff.trimEnd());
    }
  }
  if (empty) lines.push("", r.noActivity);
  lines.push("", r.agent, round.answer === null ? r.noAnswer : round.answer);
  if (round.error !== null) lines.push(r.error(round.error));
  return lines.join("\n");
}

/** 一行之内截短（回合列表一回合一行）。 */
function oneLine(text: string, max: number): string {
  const characters = Array.from(text.replace(/\s+/gu, " ").trim());
  return characters.length <= max ? characters.join("") : `${characters.slice(0, max).join("")}…`;
}

function clip(text: string, max: number, r: Reply): string {
  const characters = Array.from(text);
  if (characters.length <= max) return text;
  return `${characters.slice(0, max).join("")}\n${r.clipped(characters.length)}`;
}

function isView(value: string): value is SessionReadView {
  return (SESSION_READ_VIEWS as readonly string[]).includes(value);
}

function integerOf(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 1 ? number : null;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = integerOf(value);
  if (number === null) return fallback;
  return Math.min(max, Math.max(min, number));
}
