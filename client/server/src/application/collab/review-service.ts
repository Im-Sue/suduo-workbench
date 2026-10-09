import { randomUUID } from "node:crypto";
import {
  REVIEW_FOCUSES,
  REVIEW_SEVERITIES,
  type EventEnvelope,
  type JsonValue,
  type Locale,
  type MessageContent,
  type ReviewDto,
  type ReviewFindingDto,
  type ReviewFocus,
  type ReviewSeverity,
  type ReviewStatus,
  type SessionDto,
  type StallDto,
} from "@suduo/client-contracts";
import { messagesFor } from "../../i18n/messages/index.js";
import type { ReviewRecord, ReviewRepository } from "../../infrastructure/db/repositories/review-repository.js";
import type { SessionRecord, SessionRepository } from "../../infrastructure/db/repositories/session-repository.js";
import type { SessionThreadRepository } from "../../infrastructure/db/repositories/session-thread-repository.js";
import { ApiError, type ErrorText } from "../api-error.js";
import { changedPaths, type ProjectedRound } from "../context/session-projection.js";
import type { EventBroker } from "../event-broker.js";
import type { EventLedger } from "../event-ledger.js";
import type { SchedulerSource } from "../scheduler/turn-scheduler.js";
import { countDiff, oneLine } from "./delegation-service.js";
import { StallWatch } from "./stall-watch.js";

/**
 * 交叉评审（多 Agent 协作 S9，技术设计 2.11、需求 4.4）：请本机另一个 Agent 在只读评审会话里评审一个会话的改动，
 * 评审 Agent 用 `review_submit` 交回结构化意见；用户在被评会话的评审卡片上勾选意见交回原 Agent 修改。
 *
 * - 评审会话：同一需求 / 项目、同一目录，relation = review，固定只读（R3），开场附角色说明，只给只读工具与提交工具。
 * - 只跟评审会话的第一条消息（按 clientTurnId 认，回合按回执、出队记录或 userMessage 证据对上）：这一轮结束时提交过就是
 *   「已提交」，没提交就退化成显示它的最终回答（R13）。之后用户在评审会话里接着聊不改报告；再次提交覆盖意见。
 * - 被评会话的时间线上每次变化记一条 `review.updated`（评审卡片取最新的）。
 * - 重启：没做完的标「已中断」（评审可以重新发起）。
 */
export interface ReviewDependencies {
  reviews: ReviewRepository;
  /** 评审会话里还在等确认的操作（卡住提醒用；不给就只看有没有动静）。 */
  approvals?: { oldestPendingAt(sessionId: string): number | null };
  sessions: Pick<SessionRepository, "getById">;
  threads: Pick<SessionThreadRepository, "getPrimary">;
  ledger: Pick<EventLedger, "append">;
  broker: Pick<EventBroker, "subscribe">;
  messages: {
    send(
      sessionId: string,
      input: { content: MessageContent[] },
      idempotencyKey: string,
      options: { locale?: Locale; source?: SchedulerSource; label?: string },
    ): Promise<{ turnRef: { turnId: string } | null; queued?: { itemId: string; position: number } }>;
  };
  clientTurnId(sessionId: string, idempotencyKey: string): string;
  interrupt(sessionId: string, turnId: string): Promise<unknown>;
  scheduler: { cancel(itemId: string): boolean };
  rounds(sessionId: string): ProjectedRound[];
  /** 建只读评审会话：同一需求 / 项目，记下评审关系，带评审者的角色说明，只给只读工具与提交工具。 */
  createReviewer(input: { target: SessionRecord; agentId: string; locale: Locale }): Promise<SessionDto>;
  /** 这家 Agent 能不能评审（接上了、没停用、做得到只读）；不能时给原因。 */
  agentProblem(agentId: string): ErrorText | null;
  agentName(agentId: string): string;
  /** 被评会话关联的需求（「REQ-12 标题」）；不是需求会话为 null。 */
  requirementOf(sessionId: string): string | null;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

/** 评审会话第一条消息的跟踪。 */
interface Tracked {
  clientTurnId: string;
  turnId: string | null;
  confirmed: boolean;
  queueItemId: string | null;
}

type Outcome = { status: "completed" | "failed" | "cancelled"; error: string | null };

export class ReviewService {
  private readonly watching = new Map<string, () => void>();
  private readonly tracked = new Map<string, Tracked>();
  /** 开始 / 结束先于发送回执到达的回合（回执来了再认）。 */
  private readonly unclaimed = new Map<string, Map<string, Outcome | null>>();

  /** 卡住提醒（S12）：评审会话只读、不出审批，只会是很久没动静。 */
  private readonly stalls = new StallWatch({
    now: () => this.now(),
    oldestApprovalAt: (sessionId) => this.deps.approvals?.oldestPendingAt(sessionId) ?? null,
  });

  constructor(private readonly deps: ReviewDependencies) {}

  /** 定时看一遍没结束的评审：卡住与否变了就刷新卡片（本机服务每分钟调一次）。 */
  checkStalls(): void {
    for (const record of this.deps.reviews.listUnfinished()) {
      if (this.stalls.changed(record.id, this.stallOf(record))) this.emit(record);
    }
  }

  private stallOf(record: ReviewRecord): StallDto | null {
    return record.status === "queued" || record.status === "running"
      ? this.stalls.stalled(record.id, record.reviewerSessionId, record.status === "running")
      : null;
  }

  /** 本机服务启动时：没做完的评审收尾——已经提交过意见的保留「已提交」，其余标「已中断」（可以重新发起）。 */
  recoverAfterRestart(): void {
    for (const record of this.deps.reviews.listUnfinished()) {
      if (record.findings !== null) {
        this.update(record.id, { status: "submitted", finishedAt: this.now() });
        continue;
      }
      const target = this.deps.sessions.getById(record.targetSessionId);
      this.update(record.id, { status: "interrupted", error: messagesFor(target?.locale ?? "zh-CN").review.restartInterrupted, finishedAt: this.now() });
    }
  }

  async start(input: { targetSessionId: string; agentId: string; focus?: readonly string[]; note?: string | null; origin: "agent" | "user" }): Promise<ReviewDto> {
    const target = this.deps.sessions.getById(input.targetSessionId);
    if (target === null || target.state === "deleted") throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    if (target.kind !== "normal" || target.relation === "review") throw new ApiError(400, "VALIDATION_ERROR", (t) => t.review.reply.notMain);
    const problem = this.deps.agentProblem(input.agentId);
    if (problem !== null) throw new ApiError(400, "AGENT_NOT_READY", problem, { agentId: input.agentId });
    const focus = parseFocus(input.focus);
    if (typeof focus === "string") throw new ApiError(400, "VALIDATION_ERROR", (t) => t.review.reply.focusInvalid(focus));
    const note = typeof input.note === "string" && input.note.trim() !== "" ? input.note.trim() : null;
    const record = this.deps.reviews.create({ targetSessionId: target.id, agentId: input.agentId, origin: input.origin, focus, note, now: this.now() });
    this.emit(record);
    let reviewer: SessionDto;
    try {
      reviewer = await this.deps.createReviewer({ target, agentId: input.agentId, locale: target.locale });
    } catch (error) {
      // 建的时候已经被叫停了：保留「已取消」。
      if (this.require(record.id).finishedAt === null) this.update(record.id, { status: "failed", error: this.reason(error, target.locale), finishedAt: this.now() });
      throw error;
    }
    // 建评审会话要几秒（取远程需求、打水位线），这期间可能已经被叫停：记下评审会话，不再发任务。
    const created = this.deps.reviews.update(record.id, { reviewerSessionId: reviewer.id }, this.now());
    if (created.finishedAt !== null) return this.dto(created);
    const t = messagesFor(target.locale).review;
    const text = t.firstMessage({
      targetSessionId: target.id,
      focus: focus.map((item) => t.focusLabel[item] ?? item),
      note,
      changes: this.changeSummary(target.id, target.locale),
      requirement: this.deps.requirementOf(target.id),
    });
    return this.dispatch(record.id, reviewer.id, [{ type: "text", text }], `review:${record.id}:start`, target.locale, oneLine(target.title || text, 80));
  }

  get(id: string): ReviewDto {
    return this.dto(this.require(id));
  }

  listByTarget(targetSessionId: string): ReviewDto[] {
    return this.deps.reviews.listByTarget(targetSessionId).map((record) => this.dto(record));
  }

  /**
   * 评审 Agent 提交意见（只有评审会话能调）。参数不对时返回说明让它改了再交；可以再次提交覆盖上一次的意见。
   */
  submit(reviewerSessionId: string, args: Record<string, unknown>, locale: Locale): { ok: true; count: number } | { ok: false; message: string } {
    const r = messagesFor(locale).review.reply;
    const record = this.deps.reviews.getByReviewer(reviewerSessionId);
    if (record === null) return { ok: false, message: r.notReviewer };
    const parsed = parseFindings(args["findings"], r);
    if (typeof parsed === "string") return { ok: false, message: parsed };
    const summary = typeof args["summary"] === "string" ? args["summary"].trim() : "";
    if (summary === "") return { ok: false, message: r.summaryMissing };
    // 再次提交覆盖意见、从 f1 重新编号：之前「已交回」的标记对不上新的意见了，清掉。
    const changed = JSON.stringify(record.findings) !== JSON.stringify(parsed);
    this.update(record.id, { status: "submitted", findings: parsed, summary, ...(changed ? { appliedFindingIds: [] } : {}) });
    return { ok: true, count: parsed.length };
  }

  /** 把选中的意见拼成一条消息交给原 Agent 修改（经本机调度）；记下交回过哪些。 */
  async apply(id: string, findingIds: readonly string[]): Promise<ReviewDto> {
    const record = this.require(id);
    const target = this.deps.sessions.getById(record.targetSessionId);
    if (target === null || target.state === "deleted") throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    const chosen = (record.findings ?? []).filter((finding) => findingIds.includes(finding.id));
    if (chosen.length === 0) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.http.reviewFindingsRequired);
    const t = messagesFor(target.locale).review;
    const indent = (text: string) => text.replace(/\n/gu, "\n   ");
    const lines = chosen.map((finding, index) =>
      t.applyLine(
        index + 1,
        t.severityLabel[finding.severity] ?? finding.severity,
        where(finding),
        finding.title.replace(/\s+/gu, " "),
        indent(finding.detail),
        finding.suggestion === null ? null : indent(finding.suggestion),
      ),
    );
    await this.deps.messages.send(
      target.id,
      { content: [{ type: "text", text: t.applyMessage(this.deps.agentName(record.agentId), lines) }] },
      `review:${record.id}:apply:${randomUUID()}`,
      { locale: target.locale, source: "user", label: oneLine(chosen[0]!.title, 80) },
    );
    // 发送期间别的交回可能已经记下了：重读再合并。
    const latest = this.require(id);
    const applied = [...new Set([...latest.appliedFindingIds, ...chosen.map((finding) => finding.id)])];
    return this.dto(this.update(id, { appliedFindingIds: applied }));
  }

  /** 停止评审：排队中的出队，评审中的中断评审会话的回合；记为已取消。 */
  async cancel(id: string): Promise<ReviewDto> {
    const record = this.require(id);
    if (record.finishedAt !== null) return this.dto(record);
    const updated = this.update(id, { status: record.status === "submitted" ? "submitted" : "cancelled", finishedAt: this.now() });
    const entry = this.tracked.get(id);
    if (entry !== undefined && record.reviewerSessionId !== null) {
      if (entry.queueItemId !== null) this.deps.scheduler.cancel(entry.queueItemId);
      else if (entry.turnId !== null) await this.stopTurn(id, record.reviewerSessionId, entry.turnId);
    }
    return this.dto(updated);
  }

  /** 评审会话要被删了：没做完的评审先停。 */
  async beforeSessionsDeleted(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const record = this.deps.reviews.getByReviewer(sessionId);
      if (record !== null && record.finishedAt === null) await this.cancel(record.id);
    }
  }

  /** 评审会话删了：被评会话的卡片改显示「评审会话已删除」，意见照留。 */
  afterSessionsDeleted(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      const record = this.deps.reviews.getByReviewer(sessionId);
      if (record !== null) this.emit(record);
    }
  }

  dto(record: ReviewRecord): ReviewDto {
    const reviewer = record.reviewerSessionId === null ? null : this.deps.sessions.getById(record.reviewerSessionId);
    return {
      id: record.id,
      targetSessionId: record.targetSessionId,
      reviewerSessionId: reviewer === null || reviewer.state === "deleted" ? null : record.reviewerSessionId,
      reviewerDeleted: record.reviewerSessionId !== null && (reviewer === null || reviewer.state === "deleted"),
      agentId: record.agentId,
      agentName: this.deps.agentName(record.agentId),
      origin: record.origin,
      focus: record.focus,
      note: record.note,
      status: record.status,
      findings: record.findings ?? [],
      summary: record.summary,
      finalMessage: record.finalMessage,
      appliedFindingIds: record.appliedFindingIds,
      error: record.error,
      stalled: this.stallOf(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      finishedAt: record.finishedAt,
    };
  }

  /** 交给评审会话：先记为评审中（排上队时评审会话的 `turn.queued` 会改成排队中），发出去之后再看一眼是否已被叫停。 */
  private async dispatch(id: string, reviewerSessionId: string, content: MessageContent[], key: string, locale: Locale, label: string): Promise<ReviewDto> {
    this.update(id, { status: "running" });
    this.watch(id, reviewerSessionId);
    const entry: Tracked = { clientTurnId: this.deps.clientTurnId(reviewerSessionId, key), turnId: null, confirmed: false, queueItemId: null };
    this.tracked.set(id, entry);
    let accepted: Awaited<ReturnType<ReviewDependencies["messages"]["send"]>>;
    try {
      accepted = await this.deps.messages.send(reviewerSessionId, { content }, key, { locale, source: "review", label });
    } catch (error) {
      this.unwatch(id);
      const current = this.require(id);
      if (current.finishedAt !== null) return this.dto(current);
      return this.dto(this.update(id, { status: "failed", error: this.reason(error, locale), finishedAt: this.now() }));
    }
    if (accepted.queued !== undefined && entry.turnId === null) entry.queueItemId = accepted.queued.itemId;
    if (accepted.turnRef !== null) this.bind(id, entry, accepted.turnRef.turnId, false);
    const current = this.require(id);
    if (current.finishedAt !== null && current.status === "cancelled") {
      if (entry.queueItemId !== null) this.deps.scheduler.cancel(entry.queueItemId);
      else if (entry.turnId !== null) await this.stopTurn(id, reviewerSessionId, entry.turnId);
      return this.dto(current);
    }
    if (accepted.queued !== undefined && current.status === "running" && entry.turnId === null) return this.dto(this.update(id, { status: "queued" }));
    return this.dto(current);
  }

  private bind(id: string, entry: Tracked, turnId: string, confirmed: boolean): void {
    if (entry.confirmed && !confirmed) return;
    entry.turnId = turnId;
    entry.confirmed = entry.confirmed || confirmed;
    entry.queueItemId = null;
    const seen = this.unclaimed.get(id);
    if (seen === undefined || !seen.has(turnId)) return;
    const ended = seen.get(turnId) ?? null;
    if (ended !== null) this.end(id, ended);
    else this.started(id, turnId);
  }

  private watch(id: string, reviewerSessionId: string): void {
    if (this.watching.has(id)) return;
    this.watching.set(id, this.deps.broker.subscribe(reviewerSessionId, (event) => this.onReviewerEvent(id, event)));
  }

  private unwatch(id: string): void {
    this.watching.get(id)?.();
    this.watching.delete(id);
    this.stalls.forget(id);
    this.tracked.delete(id);
    this.unclaimed.delete(id);
  }

  /** 只认评审任务那条消息与它的回合；用户在评审会话里自己接着聊的回合不改报告。 */
  private onReviewerEvent(id: string, event: EventEnvelope<string, JsonValue>): void {
    this.stalls.touch(id);
    const entry = this.tracked.get(id);
    if (entry === undefined) return;
    const payload = objectOf(event.payload);
    const mine = payload["clientTurnId"] === entry.clientTurnId;
    const turnId = event.turnRef?.turnId ?? null;
    switch (event.type) {
      case "turn.queued":
        if (!mine) return;
        if (typeof payload["queueItemId"] === "string" && entry.turnId === null) entry.queueItemId = payload["queueItemId"];
        if (this.require(id).status === "running") this.update(id, { status: "queued" });
        return;
      case "turn.dequeued":
        if (!mine) return;
        if (payload["reason"] === "started") {
          if (typeof payload["turnId"] === "string") {
            this.bind(id, entry, payload["turnId"], false);
            this.started(id, payload["turnId"]);
          }
          return;
        }
        this.end(id, { status: "cancelled", error: null });
        return;
      case "turn.start-failed": {
        if (!mine) return;
        const error = objectOf(payload["error"])["message"];
        this.end(id, { status: "failed", error: typeof error === "string" ? error : null });
        return;
      }
      case "item.started":
      case "item.completed": {
        const item = objectOf(payload["item"]);
        if (turnId !== null && typeof item["type"] === "string" && /^usermessage$/iu.test(item["type"]) && item["clientId"] === entry.clientTurnId) {
          this.bind(id, entry, turnId, true);
        }
        return;
      }
      case "turn.started":
        if (turnId === null) return;
        if (entry.turnId === turnId) this.started(id, turnId);
        else this.remember(id, turnId, null);
        return;
      case "turn.completed":
      case "turn.interrupted": {
        if (turnId === null) return;
        const turn = objectOf(payload["turn"]);
        const status = turn["status"];
        const error = objectOf(turn["error"])["message"];
        const outcome: Outcome =
          event.type === "turn.interrupted" || status === "interrupted"
            ? { status: "cancelled", error: null }
            : { status: status === "failed" ? "failed" : "completed", error: typeof error === "string" ? error : null };
        if (entry.turnId === turnId) this.end(id, outcome);
        else this.remember(id, turnId, outcome);
        return;
      }
      default:
        return;
    }
  }

  private started(id: string, turnId: string): void {
    const record = this.deps.reviews.getById(id);
    if (record === null) return;
    if (record.status === "cancelled" && record.reviewerSessionId !== null) void this.stopTurn(id, record.reviewerSessionId, turnId);
    else if (record.status === "queued") this.update(id, { status: "running" });
  }

  /** 评审任务那一轮结束：提交过就是「已提交」；没提交就记下它的最终回答（R13）。 */
  private end(id: string, outcome: Outcome): void {
    this.unwatch(id);
    const record = this.deps.reviews.getById(id);
    if (record === null) return;
    const answer = record.reviewerSessionId === null ? null : lastAnswer(this.deps.rounds(record.reviewerSessionId));
    const status: ReviewStatus =
      record.findings !== null
        ? "submitted"
        : record.status === "cancelled" || outcome.status === "cancelled"
          ? "cancelled"
          : outcome.status === "failed"
            ? "failed"
            : "unstructured";
    this.update(id, {
      status,
      finalMessage: record.findings !== null ? record.finalMessage : answer,
      error: status === "failed" ? outcome.error : record.error,
      finishedAt: record.finishedAt ?? this.now(),
    });
  }

  private remember(id: string, turnId: string, ended: Outcome | null): void {
    const seen = this.unclaimed.get(id) ?? new Map<string, Outcome | null>();
    seen.set(turnId, ended ?? seen.get(turnId) ?? null);
    if (seen.size > 50) seen.delete(seen.keys().next().value!);
    this.unclaimed.set(id, seen);
  }

  /** 被评会话的改动（给评审者的第一条消息里列出，细节让它用 session_read 读）。 */
  private changeSummary(sessionId: string, locale: Locale): string {
    const t = messagesFor(locale).review;
    const rounds = this.deps.rounds(sessionId);
    const counts = new Map<string, { additions: number; deletions: number }>();
    for (const file of rounds.flatMap((round) => round.files)) {
      const counted = countDiff(file.diff, file.kind);
      const current = counts.get(file.path) ?? { additions: 0, deletions: 0 };
      counts.set(file.path, { additions: current.additions + counted.additions, deletions: current.deletions + counted.deletions });
    }
    const paths = [...changedPaths(rounds)];
    if (paths.length === 0) return t.noChanges;
    const shown = paths.slice(0, 60);
    return [
      t.changesHeader(paths.length),
      ...shown.map(([path, kind]) => {
        const count = counts.get(path) ?? { additions: 0, deletions: 0 };
        return t.changeLine(path, t.changeKind[kind] ?? kind, count.additions, count.deletions);
      }),
      ...(paths.length > shown.length ? [t.moreChanges(paths.length - shown.length)] : []),
    ].join("\n");
  }

  private async stopTurn(id: string, sessionId: string, turnId: string): Promise<void> {
    await this.deps.interrupt(sessionId, turnId).catch((error: unknown) => this.log({ event: "suduo.review.interrupt_failed", id, message: String(error) }));
  }

  private update(id: string, patch: Parameters<ReviewRepository["update"]>[1]): ReviewRecord {
    const record = this.deps.reviews.update(id, patch, this.now());
    this.emit(record);
    return record;
  }

  /** 被评会话的时间线上记一条：评审卡片取同一评审最新的一条。 */
  private emit(record: ReviewRecord): void {
    const binding = this.deps.threads.getPrimary(record.targetSessionId);
    if (binding === null || binding === undefined) return;
    const dto = this.dto(record);
    // 卡片显示的卡住与否以这一条为准（定时检查据此判断变没变，不重复写同样的事件）。
    this.stalls.changed(record.id, dto.stalled);
    this.deps.ledger.append({
      sessionId: record.targetSessionId,
      sessionThreadId: binding.id,
      event: {
        source: "suduo:review",
        type: "review.updated",
        payload: dto as unknown as JsonValue,
        threadRef: binding.threadRef,
        turnRef: null,
        ts: this.now(),
      },
    });
  }

  private require(id: string): ReviewRecord {
    const record = this.deps.reviews.getById(id);
    if (record === null) throw new ApiError(404, "NOT_FOUND", (t) => t.review.reply.notFound(id));
    return record;
  }

  private reason(error: unknown, locale: Locale): string {
    if (error instanceof ApiError) return error.render(messagesFor(locale));
    return error instanceof Error ? error.message : String(error);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(line: Record<string, unknown>): void {
    (this.deps.log ?? ((value) => console.error(JSON.stringify(value))))(line);
  }
}

/** 关注点：不给就是全部；有不认识的返回那个值。 */
function parseFocus(value: readonly string[] | undefined): ReviewFocus[] | string {
  if (value === undefined || value.length === 0) return [...REVIEW_FOCUSES];
  for (const item of value) if (!(REVIEW_FOCUSES as readonly string[]).includes(item)) return item;
  return REVIEW_FOCUSES.filter((item) => value.includes(item));
}

/** 解析评审意见；不对时返回说明（第几条哪里不对）。 */
/** 意见的条数与各字段长度上限（每次变化都整份写进被评会话的账本）。 */
const MAX_FINDINGS = 50;
const MAX_TITLE = 300;
const MAX_TEXT = 4000;

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parseFindings(value: unknown, r: ReturnType<typeof messagesFor>["review"]["reply"]): ReviewFindingDto[] | string {
  if (!Array.isArray(value)) return r.findingsMissing;
  if (value.length > MAX_FINDINGS) return r.tooManyFindings(MAX_FINDINGS);
  const findings: ReviewFindingDto[] = [];
  for (const [index, raw] of value.entries()) {
    const item = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const severity = item["severity"];
    if (typeof severity !== "string" || !(REVIEW_SEVERITIES as readonly string[]).includes(severity)) return r.findingInvalid(index + 1, r.severityInvalid);
    const title = typeof item["title"] === "string" ? item["title"].trim() : "";
    if (title === "") return r.findingInvalid(index + 1, r.titleMissing);
    const detail = typeof item["detail"] === "string" ? item["detail"].trim() : "";
    if (detail === "") return r.findingInvalid(index + 1, r.detailMissing);
    const line = item["line"];
    if (line !== undefined && line !== null && !(typeof line === "number" && Number.isSafeInteger(line) && line > 0)) return r.findingInvalid(index + 1, r.lineInvalid);
    const file = typeof item["file"] === "string" && item["file"].trim() !== "" ? item["file"].trim() : null;
    const suggestion = typeof item["suggestion"] === "string" && item["suggestion"].trim() !== "" ? item["suggestion"].trim() : null;
    findings.push({
      id: `f${String(index + 1)}`,
      severity: severity as ReviewSeverity,
      file: file === null ? null : clipText(file, MAX_TITLE),
      line: typeof line === "number" ? line : null,
      title: clipText(title, MAX_TITLE),
      detail: clipText(detail, MAX_TEXT),
      suggestion: suggestion === null ? null : clipText(suggestion, MAX_TEXT),
    });
  }
  return findings;
}

function where(finding: ReviewFindingDto): string | null {
  if (finding.file === null) return null;
  return finding.line === null ? finding.file : `${finding.file}:${String(finding.line)}`;
}

function lastAnswer(rounds: readonly ProjectedRound[]): string | null {
  return [...rounds].reverse().find((round) => round.answer !== null)?.answer ?? null;
}

function objectOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
}
