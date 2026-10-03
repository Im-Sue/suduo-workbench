import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import {
  completedAgentMessageText,
  localizeTurnError,
  noticeOf,
  objectValue,
} from "./shared.js";
import { buildTimeline, type ContextUsage, type TimelineEntry } from "./timeline.js";

/**
 * 事件投影层（UI 重设计版）。
 *
 * 与旧版的差异：工具/命令 item 不再平铺，而是聚合为 per-turn 的 TurnGroup
 * 状态机（consult 结论 Q1）：
 * - turn 终态事件统一收口未完成 step，避免永久 spinner；
 * - turnId 为 null 的 item 进入独立「未归属过程」组，不猜测归属；
 * - 事件缓存从 turn 中段开始回放时，该组标记 truncatedHead（partial）。
 */

/** 用户消息的归属三态（需求 R3）：只表达能证实的一种，证实不了就退回「已提交」。 */
export type MessageAttribution = "submitted" | "merged" | "new-turn";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  /**
   * 该消息所属的真实回合。
   * user 消息：由 userMessage item 报回的 `clientId → turnId` 映射解析得到
   * （message.submitted 自身不带 turnRef）；找不到映射或映射有歧义时为 null。
   * 它是「已证实的关联事实」，与 attribution 相互独立。
   */
  turnId: string | null;
  /** 发送时生成的关联键（message.submitted.payload.clientTurnId）；assistant 消息为 null。 */
  clientTurnId: string | null;
  /**
   * 归属三态：「这条话是新开了一轮，还是并入了正在跑的一轮」能证实到什么程度。
   * 与 turnId 独立——turnId 已知但该回合未见 turn.started 时仍是 "submitted"。
   * 只对 role=user 有意义；assistant 消息恒为 "new-turn"。
   */
  attribution: MessageAttribution;
  /** 归属到的回合以 interrupted 终止且本条是插入型（merged）：Codex 会清掉未消费的插入输入，这条可能没被处理到。 */
  interruptedNote: boolean;
  attachments: string[];
  /** 随消息发送的 skill 名称（气泡上显示标记，用户能确认已带上）。 */
  skills: string[];
}

export interface ToolStep {
  id: string;
  turnId: string | null;
  title: string;
  kind: "command" | "file" | "thinking" | "tool";
  status: "running" | "completed" | "aborted";
  detail: string;
  output: string;
  ts: number;
  /** 首次出现的事件 seq。「当前步骤」按它取最新，不按 ts（ts 保留首次时间且同毫秒会并列）。 */
  seq: number;
}

/** 状态行要说的「正在做什么」：running step 里 seq 最大的那个。说法按 kind 决定，不看 title。 */
export interface CurrentStep {
  kind: ToolStep["kind"];
  title: string;
  detail: string;
}

export type TurnStatus =
  | "running"
  | "completed"
  | "interrupted"
  | "failed"
  | "partial";

export interface TurnGroup {
  /** null 表示「未归属过程」（事件缺失 turnRef）。 */
  turnId: string | null;
  status: TurnStatus;
  steps: ToolStep[];
  /** 首个证据（turn.started 或首个 item）的时间。 */
  startedTs: number;
  endedTs: number | null;
  /** 回放从 turn 中段开始（缓存截断），过程记录可能不完整。 */
  truncatedHead: boolean;
  commandCount: number;
  fileCount: number;
  /** turn 失败原因（已本地化）；仅 status === "failed" 时存在。 */
  errorMessage: string | null;
  /** 仍在进行的最新一步；没有 running step 时为 null。 */
  currentStep: CurrentStep | null;
}

export interface StreamNotice {
  id: string;
  ts: number;
  text: string;
  /** important=工作台自己的重要提示（如线程重建）；info=runtime 自带的提示，弱化展示。 */
  level: "important" | "info";
}

/**
 * 覆盖所有回合（含没有任何 step 的纯文本回合）的终态元数据。
 * 过程卡列表 `turns` 的显示规则不受它影响（无 step 仍不出过程卡）；
 * 动作卡追踪与队列出队节拍都应该等这里的终态，而不是等 `turns`。
 */
export interface TurnMeta {
  turnId: string;
  status: TurnStatus;
  sawStart: boolean;
  startedTs: number;
  endedTs: number | null;
  /** 终态事件（turn.completed / turn.interrupted / turn.start-failed）的 seq；未终态为 null。供出队水位比较，不用投影全局 lastSeq 代替。 */
  endedSeq: number | null;
  /** 仍在进行的最新一步（状态行用）；没有 running step 时为 null。 */
  currentStep: CurrentStep | null;
}

export interface ConversationProjection {
  messages: ConversationMessage[];
  turns: TurnGroup[];
  notices: StreamNotice[];
  runningTurnIds: string[];
  lastSeq: number;
  /** 以真实 turnId 为键；未归属过程（turnId=null）不在其中。 */
  turnMeta: Map<string, TurnMeta>;
  /** 消息流渲染用：用户消息 / 回合 / 会话提示按先后排列（timeline.ts）。 */
  timeline: TimelineEntry[];
  /** 最近一次上下文用量；还没收到用量事件为 null。 */
  usage: ContextUsage | null;
}

interface TurnState {
  key: string;
  turnId: string | null;
  sawStart: boolean;
  terminal: "completed" | "interrupted" | "failed" | null;
  startedTs: number;
  endedTs: number | null;
  endedSeq: number | null;
  steps: Map<string, ToolStep>;
  errorMessage: string | null;
}

const UNATTACHED_KEY = "\u0000unattached";

export function projectEvents(
  events: readonly EventEnvelope<string, JsonValue>[],
): ConversationProjection {
  const messages: ConversationMessage[] = [];
  const turnStates = new Map<string, TurnState>();
  const order: string[] = [];
  const notices: StreamNotice[] = [];
  /**
   * 归属证据（技术设计 §三-3）：Codex 在 userMessage item 里把我们发送时传的
   * clientId 连同**真正收下它的回合**一起报回来。这里只记事实，归属三态在事件
   * 循环结束后按全貌求值——「T 内 seq 最小」要看完整个回合才知道。
   */
  const userItemsByTurn = new Map<string, Map<string, number>>();
  const clientIdToTurn = new Map<string, string>();
  /** 同一 clientId 被报到两个不同回合 = 歧义事件：无法证实就不说错，整条退回「已提交」。 */
  const conflictingClientIds = new Set<string>();
  const recordUserItem = (turnId: string, clientId: string, seq: number) => {
    const known = clientIdToTurn.get(clientId);
    if (known !== undefined && known !== turnId) {
      conflictingClientIds.add(clientId);
      return;
    }
    clientIdToTurn.set(clientId, turnId);
    const items = userItemsByTurn.get(turnId) ?? new Map<string, number>();
    items.set(clientId, Math.min(items.get(clientId) ?? seq, seq));
    userItemsByTurn.set(turnId, items);
  };

  const turnOf = (turnId: string | null, ts: number): TurnState => {
    const key = turnId ?? UNATTACHED_KEY;
    const existing = turnStates.get(key);
    if (existing) {
      return existing;
    }
    const created: TurnState = {
      key,
      turnId,
      sawStart: false,
      terminal: null,
      startedTs: ts,
      endedTs: null,
      endedSeq: null,
      steps: new Map(),
      errorMessage: null,
    };
    turnStates.set(key, created);
    order.push(key);
    return created;
  };

  const sorted = [...events].sort((left, right) => left.seq - right.seq);
  for (const event of sorted) {
    const payload = objectValue(event.payload);
    const turnId = event.turnRef?.turnId ?? null;
    // 凡带真实 turnId 的事件都让该回合在 turnMeta 里有一条——message.delta 等分支
    // 在下面会直接 continue，不能指望它们各自去建状态。
    if (turnId !== null) {
      turnOf(turnId, event.ts);
    }

    if (event.type === "message.submitted") {
      const content = Array.isArray(payload["content"]) ? payload["content"] : [];
      const text = content
        .map((item) => objectValue(item))
        .filter((item) => item["type"] === "text")
        .map((item) => String(item["text"] ?? ""))
        .join("\n");
      const attachments = content
        .map((item) => objectValue(item))
        .filter((item) => item["type"] === "local-image")
        .map((item) => String(item["attachmentId"] ?? "图片"));
      const skills = content
        .map((item) => objectValue(item))
        .filter((item) => item["type"] === "skill")
        .map((item) => String(item["name"] ?? "skill"));
      messages.push({
        id: event.eventId,
        role: "user",
        text,
        ts: event.ts,
        // message.submitted 不带 turnRef；真实回合由循环后的归属求值回填。
        turnId: null,
        clientTurnId:
          typeof payload["clientTurnId"] === "string" ? payload["clientTurnId"] : null,
        attribution: "submitted",
        interruptedNote: false,
        attachments,
        skills,
      });
      continue;
    }

    if (event.type === "message.delta") {
      // 同一回合可能有多段回复（中间穿插工具步骤）：按 itemId 分段，不能按回合合并，否则后段覆盖前段。
      const itemId = typeof payload["itemId"] === "string" ? payload["itemId"] : null;
      const id = "assistant:" + (itemId ?? turnId ?? event.eventId);
      const existing = messages.find((message) => message.id === id);
      const delta = String(payload["text"] ?? "");
      if (existing) {
        existing.text += delta;
      } else {
        messages.push({
          id,
          role: "assistant",
          text: delta,
          ts: event.ts,
          turnId,
          clientTurnId: null,
          attribution: "new-turn",
          interruptedNote: false,
          attachments: [],
          skills: [],
        });
      }
      continue;
    }

    if (event.type === "turn.started" && turnId) {
      const turn = turnOf(turnId, event.ts);
      turn.sawStart = true;
      turn.startedTs = Math.min(turn.startedTs, event.ts);
      continue;
    }

    if (
      (event.type === "turn.completed" ||
        event.type === "turn.interrupted" ||
        event.type === "turn.start-failed") &&
      turnId
    ) {
      const turn = turnOf(turnId, event.ts);
      // Codex 的失败回合也走 turn.completed（payload.turn.status = "failed"），
      // 必须读 payload 区分，否则失败被静默显示成「已完成」。
      const nativeTurn = objectValue(payload["turn"]);
      const failedCompletion =
        event.type === "turn.completed" && nativeTurn["status"] === "failed";
      turn.terminal =
        event.type === "turn.completed"
          ? failedCompletion
            ? "failed"
            : "completed"
          : event.type === "turn.interrupted"
            ? "interrupted"
            : "failed";
      if (turn.terminal === "failed") {
        const error = objectValue(nativeTurn["error"] ?? payload["error"]);
        turn.errorMessage = localizeTurnError(
          String(error["message"] ?? payload["message"] ?? ""),
        );
      }
      turn.endedTs = event.ts;
      turn.endedSeq = event.seq;
      // 终态收口：未完成的 step 不再等待 item.completed。
      for (const step of turn.steps.values()) {
        if (step.status === "running") {
          step.status = turn.terminal === "completed" ? "completed" : "aborted";
        }
      }
      continue;
    }

    const notice = noticeOf(event);
    if (notice !== undefined) {
      // 同一条提示每回合都可能重发：按最终展示文本去重，只留最早一条。
      if (notice !== null && !notices.some((existing) => existing.text === notice.text)) notices.push(notice);
      continue;
    }

    // runtime.error / runtime.recovery-required 由时间线（timeline.ts）落到所属回合的错误卡或会话提示，
    // 这里不再记成一个无人读取、也不会清除的全局字符串。

    if (event.type === "item.started" || event.type === "item.completed") {
      const item = objectValue(payload["item"]);
      const itemId = String(item["id"] ?? payload["itemId"] ?? event.eventId);
      const rawType = String(item["type"] ?? "tool");
      if (/^agentmessage$/i.test(rawType)) {
        // 回填端点会过滤 message.delta；agentMessage 的 completed 事件带完整正文，
        // 因此需要能独立重建助手气泡。若此前已有同一 item 的流式文本，完整正文覆盖它避免重复。
        if (event.type === "item.completed") {
          const text = completedAgentMessageText(item, payload);
          const id = "assistant:" + itemId;
          const existing = messages.find((message) => message.id === id);
          if (existing && text !== "") {
            existing.text = text;
          } else if (text !== "") {
            messages.push({
              id,
              role: "assistant",
              text,
              ts: event.ts,
              turnId,
              clientTurnId: null,
              attribution: "new-turn",
              interruptedNote: false,
              attachments: [],
              skills: [],
            });
          }
        }
        continue;
      }
      // 用户消息有独立的 message.submitted 事件，不进工作过程卡；
      // 但它的 item 是归属证据：clientId 对应我们发送时的 clientTurnId，turnRef 是真正收下它的回合。
      if (/^usermessage$/i.test(rawType)) {
        const clientId = item["clientId"];
        if (typeof clientId === "string" && clientId !== "" && turnId !== null) {
          recordUserItem(turnId, clientId, event.seq);
        }
        continue;
      }
      const kind = toolKind(rawType);
      const turn = turnOf(turnId, event.ts);
      const existing = turn.steps.get(itemId);
      turn.steps.set(itemId, {
        id: itemId,
        turnId,
        title: toolTitle(item, kind),
        kind,
        status: event.type === "item.completed" ? "completed" : "running",
        detail: toolDetail(item),
        output: existing?.output ?? "",
        ts: existing?.ts ?? event.ts,
        seq: existing?.seq ?? event.seq,
      });
      continue;
    }

    if (event.type === "command.output-delta") {
      const itemId = String(payload["itemId"] ?? event.eventId);
      const turn = turnOf(turnId, event.ts);
      const existing = turn.steps.get(itemId) ?? {
        id: itemId,
        turnId,
        title: "执行命令",
        kind: "command" as const,
        status: "running" as const,
        detail: "",
        output: "",
        ts: event.ts,
        seq: event.seq,
      };
      existing.output += String(payload["delta"] ?? "");
      turn.steps.set(itemId, existing);
    }
  }

  // 归属三态（技术设计 §三-3）：按序求值、命中即停。判据只依赖 Codex 自己的事件次序，
  // 不看本机入账先后、不看 HTTP 响应，因此历史回放与实时得到同一结果。
  for (const message of messages) {
    if (message.role !== "user" || message.clientTurnId === null) {
      continue;
    }
    const clientId = message.clientTurnId;
    if (conflictingClientIds.has(clientId)) {
      continue;
    }
    const attributedTurnId = clientIdToTurn.get(clientId);
    if (attributedTurnId === undefined) {
      continue; // ① 找不到 item → 已提交
    }
    message.turnId = attributedTurnId;
    const state = turnStates.get(attributedTurnId);
    if (!state?.sawStart) {
      continue; // ② 所属回合未见 turn.started → 已提交（关联事实保留在 turnId）
    }
    const items = userItemsByTurn.get(attributedTurnId);
    const mySeq = items?.get(clientId);
    if (items === undefined || mySeq === undefined) {
      continue;
    }
    const firstSeq = Math.min(...items.values());
    // ③ 回合内 seq 最小的 userMessage item → 已作为新一轮；④ 其余 → 已并入当前工作
    message.attribution = mySeq === firstSeq ? "new-turn" : "merged";
    message.interruptedNote =
      message.attribution === "merged" && state.terminal === "interrupted";
  }

  const turns: TurnGroup[] = [];
  const runningTurnIds: string[] = [];
  const turnMeta = new Map<string, TurnMeta>();
  for (const key of order) {
    const state = turnStates.get(key);
    if (!state) {
      continue;
    }
    if (state.turnId !== null && state.sawStart && state.terminal === null) {
      runningTurnIds.push(state.turnId);
    }
    if (state.turnId !== null) {
      turnMeta.set(state.turnId, {
        turnId: state.turnId,
        status: turnStatus(state),
        sawStart: state.sawStart,
        startedTs: state.startedTs,
        endedTs: state.endedTs,
        endedSeq: state.endedSeq,
        currentStep: currentStepOf(state),
      });
    }
    // 纯 turn.started/terminal、无任何 step 的 turn 不产出过程卡；
    // 失败 turn 例外——它往往一个 step 都没有（如模型限流），但失败必须可见。
    if (state.steps.size === 0 && state.terminal !== "failed") {
      continue;
    }
    const steps = [...state.steps.values()].sort((left, right) => left.ts - right.ts);
    turns.push({
      turnId: state.turnId,
      status: turnStatus(state),
      steps,
      startedTs: state.startedTs,
      endedTs: state.endedTs,
      truncatedHead: state.turnId !== null && !state.sawStart,
      commandCount: steps.filter((step) => step.kind === "command").length,
      fileCount: steps.filter((step) => step.kind === "file").length,
      errorMessage: state.errorMessage,
      currentStep: currentStepOf(state),
    });
  }
  turns.sort((left, right) => left.startedTs - right.startedTs);

  return {
    messages,
    turns,
    notices,
    runningTurnIds,
    lastSeq: sorted.at(-1)?.seq ?? 0,
    turnMeta,
    ...buildTimeline(sorted, messages, turnMeta),
  };
}

function currentStepOf(state: TurnState): CurrentStep | null {
  let latest: ToolStep | null = null;
  for (const step of state.steps.values()) {
    if (step.status === "running" && (latest === null || step.seq > latest.seq)) {
      latest = step;
    }
  }
  return latest === null ? null : { kind: latest.kind, title: latest.title, detail: latest.detail };
}

function turnStatus(state: TurnState): TurnStatus {
  if (state.terminal !== null) {
    return state.terminal;
  }
  if (state.turnId === null) {
    // 未归属过程无法判定生命周期：有 running step 视为进行中，否则不完整。
    return [...state.steps.values()].some((step) => step.status === "running")
      ? "running"
      : "partial";
  }
  if (state.sawStart) {
    return "running";
  }
  return "partial";
}

function toolKind(value: string): ToolStep["kind"] {
  const lower = value.toLowerCase();
  if (lower.includes("reasoning")) {
    return "thinking";
  }
  if (lower.includes("command")) {
    return "command";
  }
  if (lower.includes("file") || lower.includes("patch")) {
    return "file";
  }
  return "tool";
}

function toolTitle(item: Record<string, JsonValue>, kind: ToolStep["kind"]): string {
  if (kind === "command") {
    return "执行命令";
  }
  if (kind === "file") {
    return "更新文件";
  }
  if (kind === "thinking") {
    return "思考";
  }
  return String(item["name"] ?? item["type"] ?? "工具调用");
}

function toolDetail(item: Record<string, JsonValue>): string {
  const command = item["command"];
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command)) {
    return command.map(String).join(" ");
  }
  return String(item["path"] ?? item["status"] ?? "");
}
