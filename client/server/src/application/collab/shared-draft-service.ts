import { homedir } from "node:os";
import { sep } from "node:path";
import type { JsonValue, Locale, SecretHitDto, SessionRoundSummaryDto, SharedDraftDto, SharedDraftSummaryDto } from "@suduo/client-contracts";
import type { HandoffContent, PublishSharedItemRequest, ReviewReportContent, SharedItemContent, SharedItemDetailDto, SnapshotContent } from "@suduo/cloud-contracts";
import { SHARED_ITEM_FIELD_LIMITS, SHARED_ITEM_MAX_BYTES, SHARED_ITEM_TITLE_MAX } from "@suduo/cloud-contracts";
import { messagesFor } from "../../i18n/messages/index.js";
import type { ReviewRecord } from "../../infrastructure/db/repositories/review-repository.js";
import type { SessionRecord } from "../../infrastructure/db/repositories/session-repository.js";
import type { SharedDraftRecord, SharedDraftRepository } from "../../infrastructure/db/repositories/shared-draft-repository.js";
import { ApiError } from "../api-error.js";
import type { ProjectedRound } from "../context/session-projection.js";
import type { EventLedger } from "../event-ledger.js";
import type { SessionThreadRepository } from "../../infrastructure/db/repositories/session-thread-repository.js";
import type { AiActivityEvent } from "./ai-activity-reporter.js";
import { scanSecrets } from "./secret-scan.js";

/** 各字段上限与云端共用（起草时按它截断，预览即所发）。 */
const LIMITS = SHARED_ITEM_FIELD_LIMITS;

/**
 * 共享对象草稿（多 Agent 协作 S11，需求 4.7 / 4.13，技术设计 2.13）：交接包由当前 Agent 调 `handoff_submit` 起草，
 * 评审报告从评审卡生成，会话快照按选定的回合生成；本人在发布对话框里编辑、预览（本机扫一遍疑似密钥，标出位置，
 * 由人决定，不拦截），确认后发布到需求（团队服务器）。只有需求会话能发布（共享对象挂在需求上）。
 * 要发出去的文字里，会话工作目录换成相对路径、用户目录换成 `~`（不把本机目录结构带给团队）。
 * 草稿每次变化在起草会话的时间线上记一条 `shared_draft.updated`（只带卡片要的字段，草稿卡取最新的）。
 */
export interface SharedDraftDependencies {
  drafts: SharedDraftRepository;
  sessions: { getById(sessionId: string): SessionRecord | null };
  /** 会话关联的需求（远程编号）；不是需求会话为 null。 */
  requirementOf(sessionId: string): string | null;
  /** 会话干活的目录（快照里的文件路径换成相对它的）。 */
  sessionRoot(sessionId: string): string | null;
  reviews: { getById(reviewId: string): ReviewRecord | null };
  rounds(sessionId: string): ProjectedRound[];
  remote: { publishSharedItem(requirementId: string, input: PublishSharedItemRequest): Promise<SharedItemDetailDto> };
  ledger: Pick<EventLedger, "append">;
  threads: Pick<SessionThreadRepository, "getPrimary">;
  /** 用户目录（换成 `~`）；测试可以替换。 */
  home?: string;
  /** 协作记录上报（S11，P2-D1）：发布交接包时报一条。 */
  activity?: (event: AiActivityEvent) => void;
  now?: () => number;
}

export class SharedDraftService {
  constructor(private readonly deps: SharedDraftDependencies) {}

  /**
   * 交接包（`handoff_submit`）：当前会话已有没发布、用户也没改过的交接包草稿时覆盖它（Agent 可以改了再交）；
   * 用户改过的不覆盖，另起一份。参数不对时返回说明让它改了再交。
   */
  submitHandoff(sessionId: string, args: Record<string, unknown>, locale: Locale): { ok: true; draft: SharedDraftDto } | { ok: false; message: string } {
    const r = messagesFor(locale).sharedDraft;
    const session = this.deps.sessions.getById(sessionId);
    const requirementId = this.deps.requirementOf(sessionId);
    if (session === null || requirementId === null) return { ok: false, message: r.notRequirementSession };
    const parsed = parseHandoff(args);
    if (typeof parsed === "string") return { ok: false, message: r.handoffInvalid(parsed) };
    const content = this.scrubHandoff(parsed, sessionId);
    const open = this.deps.drafts
      .listBySession(sessionId)
      .filter((draft) => draft.kind === "handoff" && draft.status === "draft" && !draft.userEdited)
      .at(-1);
    const record =
      open === undefined
        ? this.deps.drafts.create({ kind: "handoff", sessionId, remoteRequirementId: requirementId, agentId: session.agentId, title: clip(r.handoffTitle(session.title), SHARED_ITEM_TITLE_MAX), content, now: this.now() })
        : this.deps.drafts.update(open.id, { content }, this.now());
    this.emit(record);
    return { ok: true, draft: this.dto(record) };
  }

  /** 手写交接包（R13：Agent 没有 handoff_submit 时的退路）：新起一份空的，用户在对话框里填。 */
  createManualHandoff(sessionId: string, locale: Locale): SharedDraftDto {
    const r = messagesFor(locale).sharedDraft;
    const session = this.deps.sessions.getById(sessionId);
    if (session === null) throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    const requirementId = this.deps.requirementOf(sessionId);
    if (requirementId === null) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.notRequirementSession);
    const record = this.deps.drafts.create({
      kind: "handoff",
      sessionId,
      remoteRequirementId: requirementId,
      agentId: null,
      title: clip(r.handoffTitle(session.title), SHARED_ITEM_TITLE_MAX),
      content: { summary: "", decisions: [], todo: [], risks: [], branch: null, files: [] },
      userEdited: true,
      now: this.now(),
    });
    this.emit(record);
    return this.dto(record);
  }

  /** 评审报告：从提交了结构化意见的评审生成草稿（被评会话要是需求会话）；这次评审已有没发布的草稿就用它，不再新起。 */
  createReviewDraft(reviewId: string, locale: Locale): SharedDraftDto {
    const r = messagesFor(locale).sharedDraft;
    const review = this.deps.reviews.getById(reviewId);
    if (review === null) throw new ApiError(404, "NOT_FOUND", (t) => t.sharedDraft.reviewNotFound);
    if (review.findings === null) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.reviewNotSubmitted);
    const requirementId = this.deps.requirementOf(review.targetSessionId);
    if (requirementId === null) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.notRequirementSession);
    const open = this.deps.drafts.listByReview(reviewId).find((draft) => draft.status === "draft");
    if (open !== undefined) return this.dto(open);
    const target = this.deps.sessions.getById(review.targetSessionId);
    const scrub = this.scrubber(review.targetSessionId);
    const content: ReviewReportContent = {
      summary: clip(scrub(review.summary ?? ""), LIMITS.text),
      findings: review.findings.slice(0, LIMITS.findings).map((finding) => ({
        severity: finding.severity,
        file: finding.file === null ? null : clip(scrub(finding.file), LIMITS.short),
        line: finding.line,
        title: clip(scrub(finding.title), LIMITS.short),
        detail: clip(scrub(finding.detail), LIMITS.item),
        suggestion: finding.suggestion === null ? null : clip(scrub(finding.suggestion), LIMITS.item),
      })),
      targetAgentId: target?.agentId ?? null,
    };
    const record = this.deps.drafts.create({
      kind: "review",
      sessionId: review.targetSessionId,
      reviewId,
      remoteRequirementId: requirementId,
      agentId: review.agentId,
      title: clip(r.reviewTitle(target?.title ?? ""), SHARED_ITEM_TITLE_MAX),
      content,
      now: this.now(),
    });
    this.emit(record);
    return this.dto(record);
  }

  /** 会话快照：选定的回合（从 1 开始的序号），只读。文件路径换成相对会话工作目录的。 */
  createSnapshot(sessionId: string, roundIndexes: readonly number[], locale: Locale): SharedDraftDto {
    const r = messagesFor(locale).sharedDraft;
    const session = this.deps.sessions.getById(sessionId);
    if (session === null) throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    const requirementId = this.deps.requirementOf(sessionId);
    if (requirementId === null) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.notRequirementSession);
    const wanted = new Set(roundIndexes);
    const rounds = this.deps.rounds(sessionId).filter((round) => wanted.has(round.index));
    if (rounds.length === 0) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.snapshotEmpty);
    const scrub = this.scrubber(sessionId);
    const content: SnapshotContent = {
      rounds: rounds.slice(0, LIMITS.rounds).map((round) => ({
        userText: clip(scrub(round.userText), LIMITS.text),
        answer: round.answer === null ? null : clip(scrub(round.answer), LIMITS.text),
        files: [...new Set(round.files.map((file) => clip(scrub(file.path), LIMITS.item)))].slice(0, LIMITS.list),
        commands: round.commands.slice(0, LIMITS.list).map((command) => ({ command: clip(scrub(command.command), LIMITS.item), exitCode: command.exitCode })),
        startedAt: round.startedAt,
      })),
    };
    // 生成时就看总大小：快照只能少选几轮重来（内容不能编辑），别等到发布时才说。
    const sizeBytes = Buffer.byteLength(JSON.stringify(content), "utf8");
    const limit = SHARED_ITEM_MAX_BYTES.snapshot;
    if (sizeBytes > limit) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.snapshotTooLarge(Math.ceil(sizeBytes / 1024), Math.floor(limit / 1024)));
    const record = this.deps.drafts.create({
      kind: "snapshot",
      sessionId,
      remoteRequirementId: requirementId,
      agentId: session.agentId,
      title: clip(r.snapshotTitle(session.title, rounds.map((round) => round.index)), SHARED_ITEM_TITLE_MAX),
      content,
      now: this.now(),
    });
    this.emit(record);
    return this.dto(record);
  }

  /** 会话快照选回合用的摘要（序号与快照一致）。 */
  roundSummaries(sessionId: string): SessionRoundSummaryDto[] {
    return this.deps.rounds(sessionId).map((round) => ({
      index: round.index,
      userText: clip(round.userText.replace(/\s+/gu, " ").trim(), 120),
      status: round.status === "completed" || round.status === "failed" || round.status === "interrupted" ? round.status : "running",
      startedAt: round.startedAt,
    }));
  }

  get(id: string): SharedDraftDto {
    return this.dto(this.require(id));
  }

  listBySession(sessionId: string): SharedDraftDto[] {
    return this.deps.drafts.listBySession(sessionId).map((record) => this.dto(record));
  }

  /** 这次评审最近一份草稿（评审卡显示「已发布」或「草稿」）。 */
  latestForReview(reviewId: string): SharedDraftDto | null {
    const record = this.deps.drafts.listByReview(reviewId)[0];
    return record === undefined ? null : this.dto(record);
  }

  /**
   * 改标题与内容（草稿与已发布的都能改，已发布的改了可以再发一份）；回包重新扫过疑似密钥。带了打开时看到的版本
   * （expectedUpdatedAt）而期间 Agent 又交了一版时回 409 并带上最新的，由人选载入它还是用自己的覆盖（本机草稿可以
   * 再生成，不是红线；只是告诉人，不悄悄盖掉）。
   */
  update(id: string, patch: { title?: unknown; content?: unknown }, expectedUpdatedAt?: number): SharedDraftDto {
    const record = this.requireDraft(id);
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== record.updatedAt) {
      throw new ApiError(409, "VERSION_CONFLICT", (t) => t.sharedDraft.changedSinceOpen, { latest: this.dto(record) });
    }
    const title = patch.title === undefined ? record.title : typeof patch.title === "string" && patch.title.trim() !== "" ? clip(patch.title.trim(), SHARED_ITEM_TITLE_MAX) : null;
    if (title === null) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.titleInvalid);
    let content = record.content;
    if (patch.content !== undefined) {
      const parsed = record.kind === "handoff" ? parseHandoff(patch.content) : sameShape(record.content, patch.content);
      if (typeof parsed === "string") throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.contentInvalid(parsed));
      // 用户自己改的内容原样存：发出去的就是用户看到的（Agent 交来的内容在起草时已换过本机路径）。
      content = parsed;
    }
    const next = this.deps.drafts.update(id, { title, content, userEdited: true }, this.now());
    this.emit(next);
    return this.dto(next);
  }

  /** 丢弃草稿（已发布的不能丢：本机标「已丢弃」而团队服务器上那份还在，会误导；要收回去需求那边撤回）。 */
  discard(id: string): SharedDraftDto {
    const record = this.requireDraft(id);
    if (record.status !== "draft") throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.notDiscardable);
    const next = this.deps.drafts.update(id, { status: "discarded" }, this.now());
    this.emit(next);
    return this.dto(next);
  }

  /**
   * 发布到需求（本人在对话框里确认过内容与疑似密钥提示之后）。已发布过的可以再发一份（团队里有人撤回了它，
   * 发布人能自己重新发出，ADR-0004「人能恢复」）。超过这种共享对象的总大小先说清楚，不白发一趟。
   */
  async publish(id: string, expectedUpdatedAt?: number): Promise<SharedDraftDto> {
    const record = this.requireDraft(id);
    // 发布到团队是不可逆的对外副作用（ADR-0004 红线 2）：用户预览之后内容变了（Agent 又交了一版）就不发，
    // 带上最新的请人再看一遍。
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== record.updatedAt) {
      throw new ApiError(409, "VERSION_CONFLICT", (t) => t.sharedDraft.changedSincePreview, { latest: this.dto(record) });
    }
    if (record.kind === "handoff" && (record.content as HandoffContent).summary.trim() === "") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.handoffInvalid("summary"));
    }
    const sizeBytes = Buffer.byteLength(JSON.stringify(record.content), "utf8");
    const limit = SHARED_ITEM_MAX_BYTES[record.kind];
    if (sizeBytes > limit) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.tooLarge(Math.ceil(sizeBytes / 1024), Math.floor(limit / 1024)));
    const published = await this.deps.remote
      .publishSharedItem(record.remoteRequirementId, {
        kind: record.kind,
        title: record.title,
        content: record.content,
        agentId: record.agentId,
        sessionRef: record.sessionId,
      })
      .catch((error: unknown) => {
        // 找不到：需求删了，或团队服务器还不支持共享对象（老版本没有这个接口）。说清两种可能，不只说「找不到」。
        if (error instanceof ApiError && error.statusCode === 404) throw new ApiError(404, "NOT_FOUND", (t) => t.sharedDraft.publishNotFound);
        throw error;
      });
    const next = this.deps.drafts.update(id, { status: "published", publishedItemId: published.id }, this.now());
    if (record.kind === "handoff") {
      this.deps.activity?.({ sessionId: record.sessionId, requirementId: record.remoteRequirementId, localRef: published.id, kind: "handoff", status: "completed", agentId: record.agentId ?? this.deps.sessions.getById(record.sessionId ?? "")?.agentId ?? "codex" });
    }
    this.emit(next);
    return this.dto(next);
  }

  private dto(record: SharedDraftRecord): SharedDraftDto {
    return {
      id: record.id,
      kind: record.kind,
      sessionId: record.sessionId,
      reviewId: record.reviewId,
      remoteRequirementId: record.remoteRequirementId,
      agentId: record.agentId,
      title: record.title,
      content: record.content,
      status: record.status,
      publishedItemId: record.publishedItemId,
      secretHits: hitsOf(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private emit(record: SharedDraftRecord): void {
    if (record.sessionId === null) return;
    const binding = this.deps.threads.getPrimary(record.sessionId);
    if (binding === null || binding === undefined) return;
    const summary: SharedDraftSummaryDto = {
      id: record.id,
      kind: record.kind,
      sessionId: record.sessionId,
      title: record.title,
      status: record.status,
      publishedItemId: record.publishedItemId,
      secretHitCount: hitsOf(record).length,
      updatedAt: record.updatedAt,
    };
    this.deps.ledger.append({
      sessionId: record.sessionId,
      sessionThreadId: binding.id,
      event: {
        source: "suduo:shared-draft",
        type: "shared_draft.updated",
        payload: summary as unknown as JsonValue,
        threadRef: binding.threadRef,
        turnRef: null,
        ts: this.now(),
      },
    });
  }

  private require(id: string): SharedDraftRecord {
    const record = this.deps.drafts.getById(id);
    if (record === null) throw new ApiError(404, "NOT_FOUND", (t) => t.sharedDraft.notFound);
    return record;
  }

  /** 丢弃了的不能再改、再发（前置条件：草稿已经不要了）；已发布的可以改了再发一份。 */
  private requireDraft(id: string): SharedDraftRecord {
    const record = this.require(id);
    if (record.status === "discarded") throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.notDraft);
    return record;
  }

  /** 这个会话要发出去的文字：工作目录换成相对路径、用户目录换成 `~`。 */
  private scrubber(sessionId: string): (text: string) => string {
    const root = this.deps.sessionRoot(sessionId);
    const home = this.deps.home ?? homedir();
    return (text) => scrubPaths(text, root, home);
  }

  private scrubHandoff(content: HandoffContent, sessionId: string): HandoffContent {
    const scrub = this.scrubber(sessionId);
    return {
      summary: scrub(content.summary),
      decisions: content.decisions.map(scrub),
      todo: content.todo.map(scrub),
      risks: content.risks.map(scrub),
      branch: content.branch,
      files: content.files.map(scrub),
    };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

/** 标题也会发出去：一起扫。按草稿与版本记住结果（同一版本反复取、写事件时不重复扫）。 */
const hitCache = new Map<string, { updatedAt: number; hits: SecretHitDto[] }>();
function hitsOf(record: SharedDraftRecord): SecretHitDto[] {
  const cached = hitCache.get(record.id);
  if (cached !== undefined && cached.updatedAt === record.updatedAt) return cached.hits;
  const hits = [...scanSecrets({ title: record.title }), ...scanSecrets(record.content)];
  if (hitCache.size > 500) hitCache.clear();
  hitCache.set(record.id, { updatedAt: record.updatedAt, hits });
  return hits;
}

/**
 * 文字里的本机路径：会话工作目录（及其下的文件）换成相对路径，用户目录换成 `~`。只换整段目录前缀，
 * 不动别处的文字。
 */
export function scrubPaths(text: string, root: string | null, home: string): string {
  let result = text;
  for (const [prefix, replacement] of [
    [root, ""],
    [home, "~"],
  ] as const) {
    if (prefix === null || prefix === "" || prefix === sep) continue;
    const trimmed = prefix.endsWith(sep) ? prefix.slice(0, -1) : prefix;
    // 只换整段路径的开头：前面不能接着别的路径字符（根目录是 /app 时，/srv/app/x 不能被换）；写成 file:// 或
    // vscode://file 链接的连同前缀一起换（不然工作目录与用户名照样发出去）。
    const start = "(?:file://|vscode://file|(?<![\\w./~-]))" + escapeRegExp(trimmed);
    // 目录下的文件：去掉目录前缀（工作目录）或换成 ~/（用户目录）。
    result = result.replace(new RegExp(start + escapeRegExp(sep), "gu"), replacement === "" ? "" : replacement + sep);
    // 单独出现的目录本身（后面不是路径字符）。
    result = result.replace(new RegExp(start + "(?![\\w./-])", "gu"), replacement === "" ? "." : replacement);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 交接包参数：summary 必填，其余可省；文字限长、列表限条数。不对时返回哪个字段不对。 */
export function parseHandoff(raw: unknown): HandoffContent | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "content";
  const value = raw as Record<string, unknown>;
  const summary = value["summary"];
  if (typeof summary !== "string" || summary.trim() === "") return "summary";
  const list = (key: string): string[] | string => {
    const items = value[key];
    if (items === undefined || items === null) return [];
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) return key;
    return (items as string[]).map((item) => item.trim()).filter((item) => item !== "").slice(0, LIMITS.list).map((item) => clip(item, LIMITS.item));
  };
  const decisions = list("decisions");
  const todo = list("todo");
  const risks = list("risks");
  const files = list("files");
  for (const parsed of [decisions, todo, risks, files]) {
    if (typeof parsed === "string") return parsed;
  }
  const branch = value["branch"];
  if (branch !== undefined && branch !== null && typeof branch !== "string") return "branch";
  return {
    summary: clip(summary.trim(), LIMITS.text),
    decisions: decisions as string[],
    todo: todo as string[],
    risks: risks as string[],
    branch: typeof branch === "string" && branch.trim() !== "" ? clip(branch.trim(), 255) : null,
    files: files as string[],
  };
}

/** 评审报告、快照在对话框里只能删条目、改文字：结构要和原来一致（字段同名同类型）。 */
function sameShape(original: SharedItemContent, raw: unknown): SharedItemContent | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "content";
  const keys = Object.keys(original).sort().join(",");
  if (Object.keys(raw).sort().join(",") !== keys) return "content";
  return raw as SharedItemContent;
}

/** 超长截断（按字符，不切开代理对），加「…」（同云端规整）。 */
function clip(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length <= max ? value : characters.slice(0, Math.max(0, max - 1)).join("") + "…";
}
