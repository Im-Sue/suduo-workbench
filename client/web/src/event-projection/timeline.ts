import type { DelegationDto, EventEnvelope, JsonValue, ReviewDto } from "@suduo/client-contracts";
import type { ConversationMessage, CurrentStep, TurnMeta, TurnStatus } from "./reducer.js";
import { completedAgentMessageText, codexErrorDescription, describeCodexError, localizeTurnError, noticeOf, objectValue, describePermissions, runtimeNoticeText } from "./shared.js";
import {
  dynamicToolDetail,
  dynamicToolOutput,
  dynamicToolTitle,
  sessionReadRef,
  suDuoToolConfirmationOf,
  suDuoToolConfirmationTitle,
  type SessionReadRef,
} from "./suduo-tools.js";
import { currentLocale } from "../i18n/locale.js";
import { messagesFor, type Messages } from "../i18n/messages/index.js";

/**
 * 会话时间线（技术设计 §10.1 P3a）：把事件投影成「用户消息 / 回合 / 会话提示」的有序列表，供消息流直接渲染。
 *
 * 回合内部是一条按事件先后排列的块序列：
 * - 助手文字按 itemId 分段（同一回合的多段回复不再互相覆盖），与工具步骤交错；
 * - 相邻的工具步骤聚成一个步骤组（界面上折叠成一行摘要）；文件改动单独成卡；
 * - 运行中插进来的话（并入当前回合）放在回合里它发生的位置；
 * - 计划取最新一版；回合失败 / 运行时错误落在所属回合的错误卡上（可重试的只是「正在重试」）；
 *   没有回合归属的错误成为会话提示，而不是一个无人读取的全局字符串。
 *
 * 步骤标题、审批与错误的文字按调用时的语言取（`t`，默认是当前语言的字典）；判断一律看类型与字段，不看文字。
 */

export type StepKind =
  | "command"
  | "read"
  | "search"
  | "list"
  | "thinking"
  | "tool"
  | "web"
  | "approval"
  | "other";

/** waiting：审批还在等你确认。 */
export type StepStatus = "running" | "waiting" | "completed" | "failed" | "declined" | "aborted";

export interface TimelineStep {
  id: string;
  kind: StepKind;
  /** 动作短语：「运行 pnpm test」「查看 app.ts」「思考：梳理依赖」。 */
  title: string;
  /** 原始命令 / 路径 / 查询，等宽显示。 */
  detail: string;
  /** 命令输出（终端样式）、思考摘要或工具结果。 */
  output: string;
  /** 工具进度（mcp progress 等），完成后清空。 */
  progress: string | null;
  status: StepStatus;
  exitCode: number | null;
  durationMs: number | null;
  startedTs: number;
  endedTs: number | null;
  seq: number;
  /** Agent 读另一个会话的步骤（多 Agent 协作 S7）：读的哪个会话、哪一层；界面据此显示会话名。 */
  sessionRead?: SessionReadRef;
}

export interface FileChangeEntry {
  path: string;
  kind: "add" | "delete" | "update";
  movePath: string | null;
  additions: number;
  deletions: number;
  diff: string;
}

export interface PlanStepView {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TurnPlan {
  explanation: string | null;
  steps: PlanStepView[];
}

export type TurnBlock =
  | { kind: "text"; id: string; seq: number; text: string }
  | { kind: "steps"; id: string; seq: number; steps: TimelineStep[] }
  | { kind: "file-change"; id: string; seq: number; status: StepStatus; changes: FileChangeEntry[] }
  | { kind: "user"; id: string; seq: number; message: ConversationMessage };

export interface TurnError {
  message: string;
  /** Codex 会自动重试（willRetry）：只是提示，不是失败。 */
  retrying: boolean;
}

export interface TurnSummary {
  durationMs: number | null;
  filesChanged: number;
  additions: number;
  deletions: number;
  commands: number;
}

export interface TurnTimeline {
  id: string;
  /** null = 未归属过程（事件缺失 turnRef）。 */
  turnId: string | null;
  status: TurnStatus;
  seq: number;
  startedTs: number;
  endedTs: number | null;
  /** 回放从回合中段开始（缓存截断），过程可能不完整。 */
  truncatedHead: boolean;
  blocks: TurnBlock[];
  plan: TurnPlan | null;
  error: TurnError | null;
  currentStep: CurrentStep | null;
  /** 有审批在等你确认：状态行显示「等你确认」，不再转圈。 */
  awaitingApproval: boolean;
  summary: TurnSummary;
}

export interface TimelineNotice {
  id: string;
  ts: number;
  text: string;
  level: "info" | "important" | "error";
}

export type TimelineEntry =
  | { kind: "user"; id: string; seq: number; message: ConversationMessage }
  | { kind: "turn"; id: string; seq: number; turn: TurnTimeline }
  | { kind: "notice"; id: string; seq: number; notice: TimelineNotice }
  /** 委派卡片（多 Agent 协作 S8）：出现在第一次记下的位置，内容取同一委派最新的一条。 */
  | { kind: "delegation"; id: string; seq: number; delegation: DelegationDto }
  /** 交叉评审（多 Agent 协作 S9）：同一评审只出一张卡片，取最新状态。 */
  | { kind: "review"; id: string; seq: number; review: ReviewDto }
  /**
   * 排队中的消息（多 Agent 协作 S8）：带可取消的队列项。state：还在等 / 开起来了 / 没发出（取消、重启、会话归档），
   * 按 clientTurnId 对上服务端的出队记录；本地队列据此判断这条有没有被收下。
   */
  | { kind: "queued"; id: string; seq: number; itemId: string; clientTurnId: string | null; ts: number; state: "waiting" | "started" | "dropped" | "failed" };

/** 上下文用量（输入框的用量环）：最近一次请求占用的 token 与模型上下文窗口。 */
export interface ContextUsage {
  usedTokens: number;
  contextWindow: number | null;
  totalTokens: number;
}

interface TurnDraft {
  timeline: TurnTimeline;
  sawStart: boolean;
  steps: Map<string, TimelineStep>;
  texts: Map<string, Extract<TurnBlock, { kind: "text" }>>;
  files: Map<string, Extract<TurnBlock, { kind: "file-change" }>>;
  /** 推理摘要：每个 summaryIndex 一段。 */
  reasoningParts: Map<string, string[]>;
}

export function buildTimeline(
  sortedEvents: readonly EventEnvelope<string, JsonValue>[],
  messages: readonly ConversationMessage[],
  turnMeta: ReadonlyMap<string, TurnMeta>,
  t: Messages = messagesFor(currentLocale()),
): { timeline: TimelineEntry[]; usage: ContextUsage | null } {
  const entries: TimelineEntry[] = [];
  const turns = new Map<string, TurnDraft>();
  const noticeTexts = new Set<string>();
  const userEntries = new Map<string, Extract<TimelineEntry, { kind: "user" }>>();
  const delegations = new Map<string, Extract<TimelineEntry, { kind: "delegation" }>>();
  const reviews = new Map<string, Extract<TimelineEntry, { kind: "review" }>>();
  /** 排队提示，按 clientTurnId：回合开起来或取消后不再显示「取消排队」。 */
  const queued = new Map<string, Extract<TimelineEntry, { kind: "queued" }>>();
  const messageById = new Map(messages.map((message) => [message.id, message]));
  let usage: ContextUsage | null = null;
  let unattached: TurnDraft | null = null;
  const approvals = new Map<string, { turn: TurnDraft; step: TimelineStep; kind: string }>();

  /** 审批结果对应哪条请求：优先 approvalRef；旧事件没有时取同一回合里最早还在等的那条。 */
  const findApproval = (payload: Record<string, JsonValue>, turnId: string | null) => {
    const ref = payload["approvalRef"];
    if (typeof ref === "string") return approvals.get(ref);
    for (const candidate of approvals.values()) {
      if (candidate.step.status === "waiting" && (turnId === null || candidate.turn.timeline.turnId === turnId)) return candidate;
    }
    return undefined;
  };

  const turnFor = (turnId: string | null, event: EventEnvelope<string, JsonValue>): TurnDraft => {
    if (turnId === null) {
      // 没有回合归属的过程按连续的一段聚合：中间隔了别的内容就另起一段，不猜测归属。
      const last = entries.at(-1);
      if (unattached !== null && last?.kind === "turn" && last.turn === unattached.timeline) return unattached;
      unattached = createTurn(null, event, `turn:unattached:${event.seq}`);
      return unattached;
    }
    const existing = turns.get(turnId);
    if (existing !== undefined) return existing;
    const created = createTurn(turnId, event, `turn:${turnId}`);
    turns.set(turnId, created);
    return created;
  };

  const createTurn = (turnId: string | null, event: EventEnvelope<string, JsonValue>, id: string): TurnDraft => {
    const timeline: TurnTimeline = {
      id,
      turnId,
      status: "running",
      seq: event.seq,
      startedTs: event.ts,
      endedTs: null,
      truncatedHead: false,
      blocks: [],
      plan: null,
      error: null,
      currentStep: null,
      awaitingApproval: false,
      summary: { durationMs: null, filesChanged: 0, additions: 0, deletions: 0, commands: 0 },
    };
    entries.push({ kind: "turn", id, seq: event.seq, turn: timeline });
    return { timeline, sawStart: false, steps: new Map(), texts: new Map(), files: new Map(), reasoningParts: new Map() };
  };

  const textBlock = (turn: TurnDraft, itemId: string, seq: number) => {
    const existing = turn.texts.get(itemId);
    if (existing !== undefined) return existing;
    const block: Extract<TurnBlock, { kind: "text" }> = { kind: "text", id: `text:${itemId}`, seq, text: "" };
    turn.texts.set(itemId, block);
    turn.timeline.blocks.push(block);
    return block;
  };

  const placeStep = (turn: TurnDraft, step: TimelineStep) => {
    turn.steps.set(step.id, step);
    const last = turn.timeline.blocks.at(-1);
    if (last?.kind === "steps") {
      last.steps.push(step);
      return;
    }
    turn.timeline.blocks.push({ kind: "steps", id: `steps:${step.id}`, seq: step.seq, steps: [step] });
  };

  /** 有新进展就说明重试已经接上了：撤掉「正在重试」。 */
  const progressed = (turn: TurnDraft) => {
    if (turn.timeline.error?.retrying === true) turn.timeline.error = null;
  };

  for (const event of sortedEvents) {
    const payload = objectValue(event.payload);
    const turnId = event.turnRef?.turnId ?? null;

    if (event.type === "message.submitted") {
      const message = messageById.get(event.eventId);
      if (message !== undefined) {
        const entry = { kind: "user" as const, id: `user:${event.eventId}`, seq: event.seq, message };
        userEntries.set(message.id, entry);
        entries.push(entry);
      }
      continue;
    }

    // 多 Agent 协作 S8：委派卡片与本机队列。
    if (event.type === "delegation.updated") {
      const delegation = event.payload as unknown as DelegationDto;
      const existing = delegations.get(delegation.id);
      if (existing !== undefined) existing.delegation = delegation;
      else {
        const entry = { kind: "delegation" as const, id: `delegation:${delegation.id}`, seq: event.seq, delegation };
        delegations.set(delegation.id, entry);
        entries.push(entry);
      }
      continue;
    }
    if (event.type === "review.updated") {
      const review = event.payload as unknown as ReviewDto;
      const existing = reviews.get(review.id);
      if (existing !== undefined) existing.review = review;
      else {
        const entry = { kind: "review" as const, id: `review:${review.id}`, seq: event.seq, review };
        reviews.set(review.id, entry);
        entries.push(entry);
      }
      continue;
    }
    if (event.type === "turn.queued") {
      const itemId = typeof payload["queueItemId"] === "string" ? payload["queueItemId"] : "";
      const clientTurnId = typeof payload["clientTurnId"] === "string" ? payload["clientTurnId"] : null;
      const entry = { kind: "queued" as const, id: `queued:${event.eventId}`, seq: event.seq, itemId, clientTurnId, ts: event.ts, state: "waiting" as const };
      queued.set(clientTurnId ?? itemId, entry);
      entries.push(entry);
      continue;
    }
    if (event.type === "turn.dequeued") {
      const entry = queued.get(String(payload["clientTurnId"] ?? payload["queueItemId"] ?? ""));
      const reason = payload["reason"];
      // 排上的这条开起来了：撤掉排队提示，不另记一笔。
      if (reason === "started") {
        if (entry !== undefined) entry.state = "started";
        continue;
      }
      if (entry !== undefined) entry.state = "dropped";
      const text =
        reason === "restart"
          ? t.collab.queue.dequeuedRestart
          : reason === "requeued"
            ? t.collab.queue.dequeuedRequeued
            : reason === "archived" || reason === "deleted"
              ? t.collab.queue.dequeuedInactive
              : t.collab.queue.dequeued;
      // 工作台自己的说明（这条消息没发给 Agent）：进对话流；info 级是运行时自带的提示，只收进会话头。
      entries.push({ kind: "notice", id: `notice:${event.eventId}`, seq: event.seq, notice: { id: event.eventId, ts: event.ts, text, level: "important" } });
      continue;
    }
    // 排队的消息开不起来（不属于任何回合）；属于回合的开不起来照旧在下面按回合标失败。
    if (event.type === "turn.start-failed" && turnId === null) {
      const entry = queued.get(String(payload["clientTurnId"] ?? ""));
      if (entry !== undefined) entry.state = "failed";
      const message = String(objectValue(payload["error"])["message"] ?? "");
      entries.push({ kind: "notice", id: `notice:${event.eventId}`, seq: event.seq, notice: { id: event.eventId, ts: event.ts, text: t.collab.queue.startFailed(message), level: "error" } });
      continue;
    }

    const notice = noticeOf(event, t);
    if (notice !== undefined) {
      if (notice !== null && !noticeTexts.has(notice.text)) {
        noticeTexts.add(notice.text);
        entries.push({ kind: "notice", id: `notice:${event.eventId}`, seq: event.seq, notice });
      }
      continue;
    }

    if (event.type === "usage.updated") {
      const tokenUsage = objectValue(payload["tokenUsage"]);
      const last = objectValue(tokenUsage["last"]);
      const total = objectValue(tokenUsage["total"]);
      const window = tokenUsage["modelContextWindow"];
      usage = {
        usedTokens: numberOr(last["totalTokens"], 0),
        totalTokens: numberOr(total["totalTokens"], 0),
        contextWindow: typeof window === "number" && window > 0 ? window : null,
      };
      continue;
    }

    if (event.type === "runtime.error" || event.type === "runtime.recovery-required") {
      const error = objectValue(payload["error"]);
      const raw = String(payload["message"] ?? error["message"] ?? "");
      if (turnId !== null && event.type === "runtime.error") {
        const turn = turnFor(turnId, event);
        const retrying = payload["willRetry"] === true;
        // 已经收口的回合保留收口时的原因；可重试的错误只在回合还没结束时提示。
        if (turn.timeline.endedTs !== null && (retrying || turn.timeline.error !== null)) continue;
        const described =
          Object.keys(error).length > 0
            ? codexErrorDescription(error, t)
            : { text: localizeTurnError(raw, t), reconnectAttempt: false };
        // 说法里已经带了第几次重连就照用；否则可重试的错误说成「正在自动重试」。
        turn.timeline.error = { message: retrying && !described.reconnectAttempt ? retryText(raw, t) : described.text, retrying };
        continue;
      }
      // 断线重建（code connection-rebuilt）按当前语言渲染；没有 code 的旧事件显示存下的原文。
      const text =
        event.type === "runtime.recovery-required"
          ? (runtimeNoticeText(payload, t) ?? (raw || t.timeline.notice.runtimeRecovered))
          : localizeTurnError(raw, t);
      entries.push({
        kind: "notice",
        id: `notice:${event.eventId}`,
        seq: event.seq,
        notice: { id: event.eventId, ts: event.ts, text, level: event.type === "runtime.error" ? "error" : "important" },
      });
      continue;
    }

    if (event.type === "message.delta") {
      const turn = turnFor(turnId, event);
      const itemId = typeof payload["itemId"] === "string" ? payload["itemId"] : `delta:${turnId ?? event.eventId}`;
      textBlock(turn, itemId, event.seq).text += String(payload["text"] ?? "");
      progressed(turn);
      continue;
    }

    if (event.type === "turn.started") {
      if (turnId === null) continue;
      const turn = turnFor(turnId, event);
      turn.sawStart = true;
      turn.timeline.startedTs = Math.min(turn.timeline.startedTs, event.ts);
      continue;
    }

    if (event.type === "turn.completed" || event.type === "turn.interrupted" || event.type === "turn.start-failed") {
      if (turnId === null) continue;
      const turn = turnFor(turnId, event);
      const nativeTurn = objectValue(payload["turn"]);
      const failed =
        event.type === "turn.start-failed" || (event.type === "turn.completed" && nativeTurn["status"] === "failed");
      turn.timeline.endedTs = event.ts;
      if (failed) {
        const error = objectValue(nativeTurn["error"] ?? payload["error"]);
        turn.timeline.error = {
          message: Object.keys(error).length > 0
            ? describeCodexError(error, t)
            : localizeTurnError(String(payload["message"] ?? ""), t),
          retrying: false,
        };
      } else if (turn.timeline.error?.retrying === true) {
        turn.timeline.error = null;
      }
      const closedAs: StepStatus = event.type === "turn.completed" && !failed ? "completed" : "aborted";
      // 改动卡同样收口：还在「正在修改」的，按回合结局标为完成或中止。
      for (const block of turn.files.values()) {
        if (block.status === "running") block.status = closedAs;
      }
      for (const step of turn.steps.values()) {
        if (step.status === "running" || step.status === "waiting") {
          if (step.status === "waiting") step.title = approvalTitle(approvals.get(step.id.slice("approval:".length))?.kind ?? "other", step.detail, "orphaned", t);
          step.status = step.status === "waiting" ? "aborted" : closedAs;
          step.endedTs = event.ts;
        }
      }
      continue;
    }

    if (event.type === "plan.updated") {
      const turn = turnFor(turnId, event);
      const plan = Array.isArray(payload["plan"]) ? payload["plan"] : [];
      turn.timeline.plan = {
        explanation: typeof payload["explanation"] === "string" && payload["explanation"] !== "" ? payload["explanation"] : null,
        steps: plan.map((raw) => {
          const step = objectValue(raw);
          return { text: String(step["step"] ?? ""), status: planStatus(step["status"]) };
        }),
      };
      progressed(turn);
      continue;
    }

    if (event.type === "reasoning.summary-delta" || event.type === "reasoning.summary-part-added") {
      const itemId = typeof payload["itemId"] === "string" ? payload["itemId"] : null;
      if (itemId === null) continue;
      const turn = turnFor(turnId, event);
      const step = turn.steps.get(itemId) ?? newStep(itemId, "thinking", t.timeline.step.thinking, event);
      if (!turn.steps.has(itemId)) placeStep(turn, step);
      const parts = turn.reasoningParts.get(itemId) ?? [];
      const index = numberOr(payload["summaryIndex"], parts.length === 0 ? 0 : parts.length - 1);
      while (parts.length <= index) parts.push("");
      if (event.type === "reasoning.summary-delta") parts[index] += String(payload["delta"] ?? "");
      turn.reasoningParts.set(itemId, parts);
      applyReasoning(step, parts, t);
      progressed(turn);
      continue;
    }

    if (event.type === "command.output-delta") {
      const itemId = typeof payload["itemId"] === "string" ? payload["itemId"] : null;
      if (itemId === null) continue;
      const turn = turnFor(turnId, event);
      let step = turn.steps.get(itemId);
      if (step === undefined) {
        step = newStep(itemId, "command", t.timeline.step.runCommand, event);
        placeStep(turn, step);
      }
      step.output += String(payload["delta"] ?? "");
      progressed(turn);
      continue;
    }

    if (event.type === "tool.progress") {
      const itemId = typeof payload["itemId"] === "string" ? payload["itemId"] : null;
      const step = itemId === null ? undefined : turnFor(turnId, event).steps.get(itemId);
      if (step !== undefined) step.progress = String(payload["message"] ?? "") || null;
      continue;
    }

    if (event.type === "file.patch-updated") {
      const itemId = typeof payload["itemId"] === "string" ? payload["itemId"] : null;
      // turn/diff/updated（整回合 diff，不带 itemId）交给检查面板的改动列表，这里只跟踪单个改动项。
      if (itemId === null) continue;
      const turn = turnFor(turnId, event);
      const block = fileBlock(turn, itemId, event.seq);
      block.changes = fileChanges(payload["changes"]);
      progressed(turn);
      continue;
    }

    if (event.type === "approval.requested") {
      const turn = turnFor(turnId, event);
      const ref = typeof payload["approvalRef"] === "string" ? payload["approvalRef"] : event.eventId;
      const step = newStep(`approval:${ref}`, "approval", "", event);
      step.status = "waiting";
      const request = objectValue(payload["request"]);
      // SuDuo 写工具的确认卡（发评论 / 发布确认版）：说成「发评论到 REQ-1「…」」。
      const toolConfirmation = suDuoToolConfirmationOf(event.payload);
      step.detail = toolConfirmation === null ? approvalSubject(request, t) : suDuoToolConfirmationTitle(toolConfirmation, t);
      // v2 文件改动审批只带 itemId：从同一 item 的改动卡里取要改的文件。
      if (step.detail === "" && typeof request["itemId"] === "string") {
        const changes = turn.files.get(request["itemId"])?.changes ?? [];
        if (changes.length > 0) step.detail = changes.length === 1 ? baseName(changes[0]?.path ?? "") : t.timeline.approval.files(changes.length);
      }
      // 命令审批里 kind=writeStdin 是向已在运行的命令输入内容，单独说。
      const kind =
        toolConfirmation !== null
          ? "suduo-tool"
          : payload["kind"] === "command" && request["kind"] === "writeStdin"
            ? "stdin"
            : String(payload["kind"] ?? "other");
      step.title = approvalTitle(kind, step.detail, "waiting", t);
      step.output = typeof request["reason"] === "string" ? request["reason"] : "";
      placeStep(turn, step);
      approvals.set(ref, { turn, step, kind });
      continue;
    }

    if (event.type === "approval.resolved" || event.type === "approval.orphaned" || event.type === "approval.delivery-failed") {
      const found = findApproval(payload, turnId);
      if (found === undefined) continue;
      const { step, kind } = found;
      if (event.type === "approval.resolved") {
        const decision = String(payload["decision"] ?? "");
        const accepted = decision === "accept" || decision === "acceptForSession";
        step.status = accepted ? "completed" : "declined";
        step.title = approvalTitle(kind, step.detail, decision, t);
      } else if (event.type === "approval.orphaned") {
        step.status = "aborted";
        step.title = approvalTitle(kind, step.detail, "orphaned", t);
      } else {
        step.status = "failed";
        step.title = approvalTitle(kind, step.detail, "delivery-failed", t);
      }
      step.endedTs = event.ts;
      continue;
    }

    if (event.type === "item.started" || event.type === "item.completed") {
      // item 平铺在顶层；只在 extensions.codex.params 里有原生副本的旧形状也认。
      const item = objectValue(payload["item"] ?? objectValue(objectValue(objectValue(payload["extensions"])["codex"])["params"])["item"]);
      const itemId = String(item["id"] ?? payload["itemId"] ?? event.eventId);
      const type = String(item["type"] ?? "");
      const completed = event.type === "item.completed";
      if (/^usermessage$/i.test(type)) continue; // 用户消息有独立的 message.submitted。
      const turn = turnFor(turnId, event);
      progressed(turn);

      if (/^agentmessage$/i.test(type) || type === "plan") {
        // item.started 先占住位置：回填不含 message.delta 时，文字仍排在正确的先后次序上。
        const block = textBlock(turn, itemId, event.seq);
        if (completed) {
          const text = type === "plan" ? String(item["text"] ?? "") : completedAgentMessageText(item, payload);
          if (text !== "") block.text = text;
        }
        continue;
      }

      if (type === "fileChange") {
        const block = fileBlock(turn, itemId, event.seq);
        const changes = fileChanges(item["changes"]);
        if (changes.length > 0) block.changes = changes;
        block.status = itemStatus(item["status"], completed);
        continue;
      }

      const existing = turn.steps.get(itemId);
      const step = existing ?? newStep(itemId, "other", "", event);
      describeItem(step, item, type, t);
      step.status = itemStatus(item["status"], completed);
      // 自定义工具：状态是 completed 但 success=false（工具返回失败）也标成失败。
      if (type === "dynamicToolCall" && item["success"] === false) step.status = "failed";
      if (completed) step.endedTs = event.ts;
      if (type === "reasoning") {
        const summary = Array.isArray(item["summary"]) ? item["summary"].map(String) : [];
        if (summary.length > 0) {
          turn.reasoningParts.set(itemId, summary);
          applyReasoning(step, summary, t);
        }
      }
      if (existing === undefined) placeStep(turn, step);
      continue;
    }
  }

  // 回合终态、耗时与摘要：终态以 reducer 的回合元数据为准（与队列、动作卡同一口径）。
  for (const entry of entries) {
    if (entry.kind !== "turn") continue;
    const draft = entry.turn.turnId === null ? null : turns.get(entry.turn.turnId);
    const timeline = entry.turn;
    const meta = timeline.turnId === null ? undefined : turnMeta.get(timeline.turnId);
    if (meta !== undefined) {
      timeline.status = meta.status;
      timeline.truncatedHead = !meta.sawStart;
    } else {
      const running = timeline.blocks.some((block) => block.kind === "steps" && block.steps.some((step) => step.status === "running"));
      timeline.status = running ? "running" : "partial";
      timeline.truncatedHead = draft?.sawStart !== true;
    }
    timeline.currentStep = currentStep(timeline);
    timeline.awaitingApproval =
      timeline.status === "running" &&
      timeline.blocks.some((block) => block.kind === "steps" && block.steps.some((step) => step.status === "waiting"));
    timeline.summary = summarize(timeline);
  }

  // 运行中插进来的话（已证实并入当前回合）：放进该回合，按发生先后排在对应位置。
  for (const [messageId, entry] of userEntries) {
    const message = entry.message;
    if (message.attribution !== "merged" || message.turnId === null) continue;
    const turn = turns.get(message.turnId);
    if (turn === undefined) continue;
    const blocks = turn.timeline.blocks;
    const at = blocks.findIndex((block) => block.seq > entry.seq);
    const block: TurnBlock = { kind: "user", id: `user:${messageId}`, seq: entry.seq, message };
    if (at === -1) blocks.push(block);
    else blocks.splice(at, 0, block);
    entries.splice(entries.indexOf(entry), 1);
  }

  entries.sort((left, right) => left.seq - right.seq);
  return { timeline: entries, usage };

  function fileBlock(turn: TurnDraft, itemId: string, seq: number) {
    const existing = turn.files.get(itemId);
    if (existing !== undefined) return existing;
    const block: Extract<TurnBlock, { kind: "file-change" }> = {
      kind: "file-change",
      id: `files:${itemId}`,
      seq,
      status: "running",
      changes: [],
    };
    turn.files.set(itemId, block);
    turn.timeline.blocks.push(block);
    return block;
  }
}

function newStep(id: string, kind: StepKind, title: string, event: EventEnvelope<string, JsonValue>): TimelineStep {
  return {
    id,
    kind,
    title,
    detail: "",
    output: "",
    progress: null,
    status: "running",
    exitCode: null,
    durationMs: null,
    startedTs: event.ts,
    endedTs: null,
    seq: event.seq,
  };
}

/** 按 item 类型给步骤起标题：用动作短语，命令按 Codex 的解析归为查看 / 搜索 / 列目录。 */
function describeItem(step: TimelineStep, item: Record<string, JsonValue>, type: string, t: Messages): void {
  const text = t.timeline.step;
  switch (type) {
    case "commandExecution": {
      const command = typeof item["command"] === "string" ? item["command"] : Array.isArray(item["command"]) ? item["command"].map(String).join(" ") : step.detail;
      step.detail = command;
      const actions = Array.isArray(item["commandActions"]) ? item["commandActions"].map(objectValue) : [];
      const kinds = new Set(actions.map((action) => String(action["type"] ?? "unknown")));
      if (actions.length > 0 && kinds.size === 1 && kinds.has("read")) {
        step.kind = "read";
        const names = actions.map((action) => String(action["name"] ?? action["path"] ?? ""));
        step.title = names.length === 1 ? text.read(names[0] ?? "") : text.readFiles(names.length);
      } else if (actions.length > 0 && kinds.size === 1 && kinds.has("search")) {
        step.kind = "search";
        const query = actions[0]?.["query"];
        step.title = typeof query === "string" && query !== "" ? text.search(query) : text.searchCode;
      } else if (actions.length > 0 && kinds.size === 1 && kinds.has("listFiles")) {
        step.kind = "list";
        const path = actions[0]?.["path"];
        step.title = typeof path === "string" && path !== "" ? text.listPath(path) : text.listFiles;
      } else {
        step.kind = "command";
        step.title = text.run(firstLine(command));
      }
      if (typeof item["exitCode"] === "number") step.exitCode = item["exitCode"];
      if (typeof item["durationMs"] === "number") step.durationMs = item["durationMs"];
      if (step.output === "" && typeof item["aggregatedOutput"] === "string") step.output = item["aggregatedOutput"];
      return;
    }
    case "reasoning":
      step.kind = "thinking";
      if (step.title === "") step.title = text.thinking;
      return;
    case "mcpToolCall": {
      step.kind = "tool";
      step.title = text.callMcpTool(String(item["server"] ?? ""), String(item["tool"] ?? ""));
      step.detail = compactJson(item["arguments"]);
      if (typeof item["durationMs"] === "number") step.durationMs = item["durationMs"];
      const error = objectValue(item["error"]);
      if (typeof error["message"] === "string") step.output = error["message"];
      else if (item["result"] !== null && item["result"] !== undefined) step.output = compactJson(item["result"]);
      if (item["status"] !== "inProgress") step.progress = null;
      return;
    }
    case "dynamicToolCall": {
      // SuDuo 工具（ADR-0008）：动作名 + 关键参数 + 返回的文字；未知工具显示原名。
      const tool = typeof item["tool"] === "string" ? item["tool"] : "";
      step.kind = "tool";
      step.title = dynamicToolTitle(tool, t);
      step.detail = dynamicToolDetail(tool, item["arguments"], t);
      const read = sessionReadRef(tool, item["arguments"]);
      if (read !== null) step.sessionRead = read;
      if (typeof item["durationMs"] === "number") step.durationMs = item["durationMs"];
      const output = dynamicToolOutput(item["contentItems"], t);
      if (output !== "") step.output = output;
      return;
    }
    case "webSearch":
      step.kind = "web";
      step.title = typeof item["query"] === "string" && item["query"] !== "" ? text.webSearch(item["query"]) : text.webSearchAny;
      return;
    case "imageView":
      step.kind = "read";
      step.title = text.viewImage(baseName(String(item["path"] ?? "")));
      step.detail = String(item["path"] ?? "");
      return;
    case "contextCompaction":
      step.title = text.contextCompaction;
      return;
    case "enteredReviewMode":
      step.title = text.enterReview;
      return;
    case "exitedReviewMode":
      step.title = text.exitReview;
      return;
    case "sleep":
      step.title = text.sleep;
      if (typeof item["durationMs"] === "number") step.durationMs = item["durationMs"];
      return;
    case "imageGeneration":
      step.title = text.generateImage;
      return;
    case "collabAgentToolCall":
    case "subAgentActivity":
      step.kind = "tool";
      step.title = text.collabAgent;
      return;
    default:
      if (step.title === "") step.title = type === "" ? text.toolCall : String(item["name"] ?? type);
  }
}

/** 审批请求要确认的对象：命令原文、要改的文件，或要的权限范围。 */
function approvalSubject(request: Record<string, JsonValue>, t: Messages): string {
  const command = request["command"];
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.map(String).join(" ");
  if (typeof request["path"] === "string") return request["path"];
  const permissions = describePermissions(request["permissions"], t);
  if (permissions !== "") return permissions;
  const changes = request["changes"];
  if (changes !== null && typeof changes === "object" && !Array.isArray(changes)) {
    const paths = Object.keys(changes);
    if (paths.length > 0) return paths.length === 1 ? (paths[0] ?? "") : t.timeline.approval.files(paths.length);
  }
  return "";
}

/** 审批步骤的标题：「等你确认：运行 pnpm test」。kind 是审批类型，state 是等待中 / 决定 / 失效 / 没送达。 */
function approvalTitle(kind: string, subject: string, state: string, t: Messages): string {
  const text = t.timeline.approval;
  const what = approvalWhat(kind, subject, text);
  switch (state) {
    case "waiting":
      return text.state.waiting(what);
    case "accept":
      return text.state.accepted(what);
    case "acceptForSession":
      return text.state.acceptedForSession(what);
    case "decline":
      return text.state.declined(what);
    case "cancel":
      return text.state.cancelled(what);
    case "delivery-failed":
      return text.state.deliveryFailed(what);
    default:
      return text.state.expired(what);
  }
}

/** 要确认的事：有具体对象时带上对象（命令只取第一行），没有时只说动作。 */
function approvalWhat(kind: string, subject: string, text: Messages["timeline"]["approval"]): string {
  if (subject !== "") {
    if (kind === "suduo-tool") return subject;
    if (kind === "command") return text.subject.command(firstLine(subject));
    if (kind === "stdin") return text.subject.stdin(firstLine(subject));
    if (kind === "file-change") return text.subject.fileChange(subject);
    if (kind === "permissions") return text.subject.permissions(subject.split("\n"));
  }
  if (kind === "command") return text.action.command;
  if (kind === "stdin") return text.action.stdin;
  if (kind === "file-change") return text.action.fileChange;
  if (kind === "permissions") return text.action.permissions;
  return text.action.other;
}

/** Codex 推理摘要常以「**标题**」开头：标题进步骤名，全文进输出。 */
function applyReasoning(step: TimelineStep, parts: readonly string[], t: Messages): void {
  const text = parts.filter((part) => part.trim() !== "").join("\n\n");
  step.output = text;
  const heading = /^\s*\*\*(.+?)\*\*/.exec(text)?.[1]?.trim();
  step.title = heading === undefined || heading === "" ? t.timeline.step.thinking : t.timeline.step.thinkingAbout(heading);
}

function itemStatus(value: JsonValue | undefined, completed: boolean): StepStatus {
  if (value === "failed") return "failed";
  if (value === "declined") return "declined";
  if (value === "completed") return "completed";
  if (value === "inProgress") return completed ? "completed" : "running";
  return completed ? "completed" : "running";
}

function planStatus(value: JsonValue | undefined): PlanStepView["status"] {
  if (value === "completed") return "completed";
  if (value === "inProgress" || value === "in_progress") return "in_progress";
  return "pending";
}

function fileChanges(value: JsonValue | undefined): FileChangeEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const change = objectValue(raw);
    const kind = objectValue(change["kind"]);
    const type = kind["type"] === "add" || kind["type"] === "delete" ? kind["type"] : "update";
    const diff = typeof change["diff"] === "string" ? change["diff"] : "";
    const counts = countDiff(diff, type);
    return {
      path: String(change["path"] ?? ""),
      kind: type,
      movePath: typeof kind["move_path"] === "string" ? kind["move_path"] : null,
      additions: counts.additions,
      deletions: counts.deletions,
      diff,
    };
  });
}

/** 统计 +/- 行数：统一 diff 按行首符号计（跳过文件头）；新增 / 删除文件的内容按整份计。 */
export function countDiff(diff: string, kind: FileChangeEntry["kind"]): { additions: number; deletions: number } {
  if (diff === "") return { additions: 0, deletions: 0 };
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const unified = lines.some((line) => line.startsWith("@@"));
  if (!unified) {
    return kind === "delete" ? { additions: 0, deletions: lines.length } : { additions: lines.length, deletions: 0 };
  }
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function currentStep(turn: TurnTimeline): CurrentStep | null {
  if (turn.status !== "running") return null;
  let latest: TimelineStep | null = null;
  for (const block of turn.blocks) {
    if (block.kind !== "steps") continue;
    for (const step of block.steps) {
      if (step.status === "running" && (latest === null || step.seq > latest.seq)) latest = step;
    }
  }
  return latest === null ? null : { kind: currentStepKind(latest.kind), title: latest.title, detail: latest.detail };
}

/** 时间线的步骤分得更细；状态行只区分命令、思考和其他工具调用（文件改动在时间线里不是步骤）。 */
function currentStepKind(kind: StepKind): CurrentStep["kind"] {
  if (kind === "command") return "command";
  if (kind === "thinking") return "thinking";
  return "tool";
}

function summarize(turn: TurnTimeline): TurnSummary {
  const paths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let commands = 0;
  for (const block of turn.blocks) {
    if (block.kind === "file-change" && (block.status === "completed" || block.status === "running")) {
      for (const change of block.changes) {
        paths.add(change.path);
        additions += change.additions;
        deletions += change.deletions;
      }
    }
    if (block.kind === "steps") commands += block.steps.filter((step) => step.kind === "command").length;
  }
  return {
    durationMs: turn.endedTs === null ? null : Math.max(0, turn.endedTs - turn.startedTs),
    filesChanged: paths.size,
    additions,
    deletions,
    commands,
  };
}

function retryText(raw: string, t: Messages): string {
  return raw === "" ? t.timeline.error.noResponseRetrying : t.timeline.error.retrying(localizeTurnError(raw, t));
}

function numberOr(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function compactJson(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
