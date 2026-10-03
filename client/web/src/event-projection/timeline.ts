import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import type { ConversationMessage, CurrentStep, TurnMeta, TurnStatus } from "./reducer.js";
import { completedAgentMessageText, describeCodexError, localizeTurnError, noticeOf, objectValue, describePermissions } from "./shared.js";
import {
  dynamicToolDetail,
  dynamicToolOutput,
  dynamicToolTitle,
  suDuoToolConfirmationOf,
  suDuoToolConfirmationTitle,
} from "./suduo-tools.js";

/**
 * 会话时间线（技术设计 §10.1 P3a）：把事件投影成「用户消息 / 回合 / 会话提示」的有序列表，供消息流直接渲染。
 *
 * 回合内部是一条按事件先后排列的块序列：
 * - 助手文字按 itemId 分段（同一回合的多段回复不再互相覆盖），与工具步骤交错；
 * - 相邻的工具步骤聚成一个步骤组（界面上折叠成一行摘要）；文件改动单独成卡；
 * - 运行中插进来的话（并入当前回合）放在回合里它发生的位置；
 * - 计划取最新一版；回合失败 / 运行时错误落在所属回合的错误卡上（可重试的只是「正在重试」）；
 *   没有回合归属的错误成为会话提示，而不是一个无人读取的全局字符串。
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
  | { kind: "notice"; id: string; seq: number; notice: TimelineNotice };

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
): { timeline: TimelineEntry[]; usage: ContextUsage | null } {
  const entries: TimelineEntry[] = [];
  const turns = new Map<string, TurnDraft>();
  const noticeTexts = new Set<string>();
  const userEntries = new Map<string, Extract<TimelineEntry, { kind: "user" }>>();
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

    const notice = noticeOf(event);
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
        const described = Object.keys(error).length > 0 ? describeCodexError(error) : localizeTurnError(raw);
        turn.timeline.error = { message: retrying && !/正在(重连|自动重试)/.test(described) ? retryText(raw) : described, retrying };
        continue;
      }
      const text = event.type === "runtime.recovery-required" ? raw || "运行时连接已恢复，可以继续工作" : localizeTurnError(raw);
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
            ? describeCodexError(error)
            : localizeTurnError(String(payload["message"] ?? "")),
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
          if (step.status === "waiting") step.title = approvalTitle(approvals.get(step.id.slice("approval:".length))?.kind ?? "other", step.detail, "orphaned");
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
      const step = turn.steps.get(itemId) ?? newStep(itemId, "thinking", "思考", event);
      if (!turn.steps.has(itemId)) placeStep(turn, step);
      const parts = turn.reasoningParts.get(itemId) ?? [];
      const index = numberOr(payload["summaryIndex"], parts.length === 0 ? 0 : parts.length - 1);
      while (parts.length <= index) parts.push("");
      if (event.type === "reasoning.summary-delta") parts[index] += String(payload["delta"] ?? "");
      turn.reasoningParts.set(itemId, parts);
      applyReasoning(step, parts);
      progressed(turn);
      continue;
    }

    if (event.type === "command.output-delta") {
      const itemId = typeof payload["itemId"] === "string" ? payload["itemId"] : null;
      if (itemId === null) continue;
      const turn = turnFor(turnId, event);
      let step = turn.steps.get(itemId);
      if (step === undefined) {
        step = newStep(itemId, "command", "运行命令", event);
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
      step.detail = toolConfirmation === null ? approvalSubject(request) : suDuoToolConfirmationTitle(toolConfirmation);
      // v2 文件改动审批只带 itemId：从同一 item 的改动卡里取要改的文件。
      if (step.detail === "" && typeof request["itemId"] === "string") {
        const changes = turn.files.get(request["itemId"])?.changes ?? [];
        if (changes.length > 0) step.detail = changes.length === 1 ? baseName(changes[0]?.path ?? "") : `${changes.length} 个文件`;
      }
      // 命令审批里 kind=writeStdin 是向已在运行的命令输入内容，单独说。
      const kind =
        toolConfirmation !== null
          ? "suduo-tool"
          : payload["kind"] === "command" && request["kind"] === "writeStdin"
            ? "stdin"
            : String(payload["kind"] ?? "other");
      step.title = approvalTitle(kind, step.detail, "waiting");
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
        step.title = approvalTitle(kind, step.detail, decision);
      } else if (event.type === "approval.orphaned") {
        step.status = "aborted";
        step.title = approvalTitle(kind, step.detail, "orphaned");
      } else {
        step.status = "failed";
        step.title = approvalTitle(kind, step.detail, "delivery-failed");
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
      describeItem(step, item, type);
      step.status = itemStatus(item["status"], completed);
      // 自定义工具：状态是 completed 但 success=false（工具返回失败）也标成失败。
      if (type === "dynamicToolCall" && item["success"] === false) step.status = "failed";
      if (completed) step.endedTs = event.ts;
      if (type === "reasoning") {
        const summary = Array.isArray(item["summary"]) ? item["summary"].map(String) : [];
        if (summary.length > 0) {
          turn.reasoningParts.set(itemId, summary);
          applyReasoning(step, summary);
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
function describeItem(step: TimelineStep, item: Record<string, JsonValue>, type: string): void {
  switch (type) {
    case "commandExecution": {
      const command = typeof item["command"] === "string" ? item["command"] : Array.isArray(item["command"]) ? item["command"].map(String).join(" ") : step.detail;
      step.detail = command;
      const actions = Array.isArray(item["commandActions"]) ? item["commandActions"].map(objectValue) : [];
      const kinds = new Set(actions.map((action) => String(action["type"] ?? "unknown")));
      if (actions.length > 0 && kinds.size === 1 && kinds.has("read")) {
        step.kind = "read";
        const names = actions.map((action) => String(action["name"] ?? action["path"] ?? ""));
        step.title = names.length === 1 ? `查看 ${names[0]}` : `查看 ${names.length} 个文件`;
      } else if (actions.length > 0 && kinds.size === 1 && kinds.has("search")) {
        step.kind = "search";
        const query = actions[0]?.["query"];
        step.title = typeof query === "string" && query !== "" ? `搜索「${query}」` : "搜索代码";
      } else if (actions.length > 0 && kinds.size === 1 && kinds.has("listFiles")) {
        step.kind = "list";
        const path = actions[0]?.["path"];
        step.title = typeof path === "string" && path !== "" ? `列出 ${path}` : "列出文件";
      } else {
        step.kind = "command";
        step.title = `运行 ${firstLine(command)}`;
      }
      if (typeof item["exitCode"] === "number") step.exitCode = item["exitCode"];
      if (typeof item["durationMs"] === "number") step.durationMs = item["durationMs"];
      if (step.output === "" && typeof item["aggregatedOutput"] === "string") step.output = item["aggregatedOutput"];
      return;
    }
    case "reasoning":
      step.kind = "thinking";
      if (step.title === "") step.title = "思考";
      return;
    case "mcpToolCall": {
      step.kind = "tool";
      step.title = `调用 ${String(item["server"] ?? "")} · ${String(item["tool"] ?? "")}`;
      step.detail = compactJson(item["arguments"]);
      if (typeof item["durationMs"] === "number") step.durationMs = item["durationMs"];
      const error = objectValue(item["error"]);
      if (typeof error["message"] === "string") step.output = error["message"];
      else if (item["result"] !== null && item["result"] !== undefined) step.output = compactJson(item["result"]);
      if (item["status"] !== "inProgress") step.progress = null;
      return;
    }
    case "dynamicToolCall": {
      // SuDuo 工具（ADR-0008）：中文动作名 + 关键参数 + 返回的文字；未知工具显示原名。
      const tool = typeof item["tool"] === "string" ? item["tool"] : "";
      step.kind = "tool";
      step.title = dynamicToolTitle(tool);
      step.detail = dynamicToolDetail(tool, item["arguments"]);
      if (typeof item["durationMs"] === "number") step.durationMs = item["durationMs"];
      const output = dynamicToolOutput(item["contentItems"]);
      if (output !== "") step.output = output;
      return;
    }
    case "webSearch":
      step.kind = "web";
      step.title = typeof item["query"] === "string" && item["query"] !== "" ? `搜索网页「${item["query"]}」` : "搜索网页";
      return;
    case "imageView":
      step.kind = "read";
      step.title = `查看图片 ${baseName(String(item["path"] ?? ""))}`;
      step.detail = String(item["path"] ?? "");
      return;
    case "contextCompaction":
      step.title = "压缩了较早的对话，腾出上下文空间";
      return;
    case "enteredReviewMode":
      step.title = "进入代码审查";
      return;
    case "exitedReviewMode":
      step.title = "结束代码审查";
      return;
    case "sleep":
      step.title = "等待";
      if (typeof item["durationMs"] === "number") step.durationMs = item["durationMs"];
      return;
    case "imageGeneration":
      step.title = "生成图片";
      return;
    case "collabAgentToolCall":
    case "subAgentActivity":
      step.kind = "tool";
      step.title = "协作代理";
      return;
    default:
      if (step.title === "") step.title = type === "" ? "工具调用" : String(item["name"] ?? type);
  }
}

/** 审批请求要确认的对象：命令原文、要改的文件，或要的权限范围。 */
function approvalSubject(request: Record<string, JsonValue>): string {
  const command = request["command"];
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.map(String).join(" ");
  if (typeof request["path"] === "string") return request["path"];
  const permissions = describePermissions(request["permissions"]);
  if (permissions !== "") return permissions;
  const changes = request["changes"];
  if (changes !== null && typeof changes === "object" && !Array.isArray(changes)) {
    const paths = Object.keys(changes);
    if (paths.length > 0) return paths.length === 1 ? (paths[0] ?? "") : `${paths.length} 个文件`;
  }
  return "";
}

const APPROVAL_VERB: Record<string, string> = {
  command: "运行命令",
  stdin: "向正在运行的命令输入内容",
  "file-change": "修改文件",
  permissions: "变更权限",
};

function approvalTitle(kind: string, subject: string, state: string): string {
  const verb = APPROVAL_VERB[kind] ?? "继续";
  const what =
    kind === "suduo-tool" && subject !== ""
      ? subject
      : kind === "command" && subject !== ""
        ? `运行 ${firstLine(subject)}`
        : kind === "stdin" && subject !== ""
          ? `向 ${firstLine(subject)} 输入内容`
          : subject !== "" && kind === "file-change"
            ? `修改 ${subject}`
            : subject !== "" && kind === "permissions"
              ? `${verb}（${subject.split("\n").join("、")}）`
              : verb;
  switch (state) {
    case "waiting":
      return `等你确认：${what}`;
    case "accept":
      return `已批准：${what}`;
    case "acceptForSession":
      return `已批准（本会话同类不再询问）：${what}`;
    case "decline":
      return `已拒绝：${what}`;
    case "cancel":
      return `已拒绝并中断：${what}`;
    case "delivery-failed":
      return `审批没能送达：${what}`;
    default:
      return `审批已失效：${what}`;
  }
}

/** Codex 推理摘要常以「**标题**」开头：标题进步骤名，全文进输出。 */
function applyReasoning(step: TimelineStep, parts: readonly string[]): void {
  const text = parts.filter((part) => part.trim() !== "").join("\n\n");
  step.output = text;
  const heading = /^\s*\*\*(.+?)\*\*/.exec(text)?.[1]?.trim();
  step.title = heading === undefined || heading === "" ? "思考" : `思考：${heading}`;
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

function retryText(raw: string): string {
  const reason = localizeTurnError(raw);
  return raw === "" ? "模型服务暂时没有响应，正在自动重试…" : `${reason.replace(/[。.]$/, "")}，正在自动重试…`;
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
