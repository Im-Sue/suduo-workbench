import type { MessageContent } from "@suduo/client-contracts";
import { ApiClientError } from "../api/client.js";
import type { ConversationProjection } from "../event-projection/reducer.js";
import { isTerminalStatus } from "./run-state.js";

/**
 * 前端消息队列（PR5，技术设计 §四.2）：想到第三件事但不想打断 Codex，就排进队列；
 * 当前回合正常结束后自动发出队首一条，等**这一条落进的真实回合**结束再取下一条。
 *
 * 三条底线：
 * - 一个真实回合终态只取一项：出队时记 `awaitingTurnId`（归属解析出的真实 turnId）与投影水位
 *   `dequeueSeq`，只有该回合终态且 `endedSeq > dequeueSeq` 才前进。不看 HTTP 响应里的 turnId
 *   （运行中发送时那是幽灵 id），不用投影全局 lastSeq 代替目标回合的终态 seq。
 * - 不确定就停，不重试：停止、失败、发送结果不确定、归属未证实、刷新 / 切回会话，一律 paused，
 *   理由如实显示，等人恢复；恢复也绝不自动重发已经出现在消息流里的东西。
 * - 只承诺当前标签页：队列文本进 sessionStorage，关页即失效，不外发（设计 §六 隐私说明）。
 */

export interface QueueItem {
  id: string;
  text: string;
  /** 入队时选中的 skill：连 name 一起存，出队组装不依赖当时的 skills 列表是否已加载。 */
  skill?: { name: string; path: string };
  attachmentIds: string[];
  /**
   * 「待核对」：发送结果不确定（断网 / 超时 / 5xx / 启动 turn 的结果不确定）时留在队列区，
   * 可取回输入框或删除，**永不自动出队**——HTTP 失败不等于未发送，气泡可能稍后出现。
   */
  unconfirmed?: true;
}

export type QueueStatus = "idle" | "waiting" | "dispatch" | "paused";

export type PausedReason =
  | "user_stop"
  | "turn_failed"
  | "turn_interrupted"
  | "send_rejected"
  | "send_uncertain"
  | "attribution_unconfirmed"
  | "restored";

export interface QueueInflight {
  item: QueueItem;
  /** HTTP 受理后才有；用它在投影里找归属。 */
  clientTurnId: string | null;
  /** 归属解析出的真实 turnId；只等它的终态。 */
  awaitingTurnId: string | null;
  /** 出队时的投影水位：回放的旧终态 seq 不会大于它。 */
  dequeueSeq: number;
  acceptedAt: number | null;
}

export interface QueueState {
  items: QueueItem[];
  status: QueueStatus;
  pausedReason: PausedReason | null;
  /** 已出队、视为已发送、等归属与终态的那一项；刷新即丢（出队即视为已发送）。 */
  inflight: QueueInflight | null;
  /**
   * 「新到的 failed / interrupted 终态 → 暂停」只看这个水位之后的终态。
   * null = 还没对过账：首次 reconcile 只把它设为当前 lastSeq，不判任何历史终态。
   */
  seenSeq: number | null;
}

/** 归属等待期限：HTTP 受理后这么久还没在事件流里找到真实回合，就暂停并如实说不知道。不是反馈时序阈值（R10）。 */
export const ATTRIBUTION_DEADLINE_MS = 10_000;

export const STORAGE_KEY_PREFIX = "suduo.session.queue:";

interface StoredQueue {
  items: QueueItem[];
  status: QueueStatus;
  pausedReason?: PausedReason;
}

export function emptyQueue(): QueueState {
  return { items: [], status: "idle", pausedReason: null, inflight: null, seenSeq: null };
}

function hasSendable(items: readonly QueueItem[]): boolean {
  return items.some((item) => item.unconfirmed !== true);
}

function settled(state: QueueState, items: QueueItem[]): QueueState {
  if (state.status === "paused" || state.status === "dispatch") {
    return { ...state, items };
  }
  return { ...state, items, status: hasSendable(items) ? "waiting" : "idle" };
}

export function enqueue(state: QueueState, item: QueueItem): QueueState {
  return settled(state, [...state.items, item]);
}

export function removeItem(state: QueueState, id: string): QueueState {
  if (!state.items.some((item) => item.id === id)) {
    return state;
  }
  return settled(state, state.items.filter((item) => item.id !== id));
}

export function updateItem(state: QueueState, id: string, text: string): QueueState {
  if (!state.items.some((item) => item.id === id)) {
    return state;
  }
  return { ...state, items: state.items.map((item) => (item.id === id ? { ...item, text } : item)) };
}

/** 取回输入框：从队列移除并把内容交给调用方。 */
export function takeItem(state: QueueState, id: string): { state: QueueState; item: QueueItem | null } {
  const item = state.items.find((entry) => entry.id === id) ?? null;
  return { state: item === null ? state : removeItem(state, id), item };
}

/** 暂停不清 inflight：已经发出去的那一条仍要等它的终态对账，只是不再取下一项。 */
export function pause(state: QueueState, reason: PausedReason): QueueState {
  if (state.status === "paused" && state.pausedReason === reason) {
    return state;
  }
  return { ...state, status: "paused", pausedReason: reason };
}

/**
 * 恢复只把状态置回 waiting / idle；出队仍受「无回合在跑且 inflight 为空」约束。
 * 待核对项不会因恢复而被重发（它不是可发项）；归属未证实的项早已不在队列里。
 */
export function resume(state: QueueState): QueueState {
  if (state.status !== "paused") {
    return state;
  }
  return { ...state, status: hasSendable(state.items) ? "waiting" : "idle", pausedReason: null };
}

export function canDispatch(state: QueueState, projection: ConversationProjection): boolean {
  return (
    state.status === "waiting" &&
    state.inflight === null &&
    projection.runningTurnIds.length === 0 &&
    hasSendable(state.items)
  );
}

/** 出队：首个可发项进入在途，记下当时的投影水位。调用方负责真正发送。 */
export function beginDispatch(state: QueueState, lastSeq: number): QueueState {
  const index = state.items.findIndex((item) => item.unconfirmed !== true);
  if (index < 0 || state.inflight !== null) {
    return state;
  }
  const item = state.items[index] as QueueItem;
  return {
    ...state,
    items: state.items.filter((_, position) => position !== index),
    status: "dispatch",
    inflight: { item, clientTurnId: null, awaitingTurnId: null, dequeueSeq: lastSeq, acceptedAt: null },
  };
}

export function onSendAccepted(state: QueueState, clientTurnId: string | undefined, now: number): QueueState {
  if (state.inflight === null) {
    return state;
  }
  return { ...state, inflight: { ...state.inflight, clientTurnId: clientTurnId ?? null, acceptedAt: now } };
}

/** 证实未受理（服务端明确拒绝且未入账）：放回队首，暂停等人决定要不要重发。 */
export function onSendRejected(state: QueueState): QueueState {
  if (state.inflight === null) {
    return state;
  }
  return pause({ ...state, items: [state.inflight.item, ...state.items], inflight: null }, "send_rejected");
}

/** 结果不确定：放回队列区标「待核对」，暂停；绝不自动重发。 */
export function onSendUncertain(state: QueueState): QueueState {
  if (state.inflight === null) {
    return state;
  }
  const unconfirmed: QueueItem = { ...state.inflight.item, unconfirmed: true };
  return pause({ ...state, items: [unconfirmed, ...state.items], inflight: null }, "send_uncertain");
}

export type SendFailureKind = "rejected" | "uncertain";

/**
 * 发送失败分类：只有服务端**明确拒绝且发生在入账之前**才算证实未受理——
 * `ApiClientError` 4xx 且不是 `IDEMPOTENCY_INDETERMINATE`（校验 / 会话不存在 / 无 primary thread 等
 * 都在 `ledger.append` 之前抛）。其余一律不确定：409 `IDEMPOTENCY_INDETERMINATE`（入账后启动 turn 失败）、
 * 5xx（含回合已启动后幂等记录写失败）、网络错误、超时、任何非 ApiClientError。
 */
export function classifySendFailure(error: unknown): SendFailureKind {
  if (
    error instanceof ApiClientError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.code !== "IDEMPOTENCY_INDETERMINATE"
  ) {
    return "rejected";
  }
  return "uncertain";
}

/**
 * 用最新投影对账（每次投影变化与每秒 tick 各跑一次）：
 * 1. 新到的 failed / interrupted 终态（含不是队列发出的回合）→ paused；
 * 2. 在途项：先由 clientTurnId 解析真实回合；超过归属期限还没解析出 → paused，项不回队；
 *    解析出后等该回合终态且 endedSeq > 出队水位 → completed 前进 / 其它终态暂停。
 */
export function reconcile(state: QueueState, projection: ConversationProjection, now: number): QueueState {
  let next = state;
  if (state.seenSeq !== null && (state.items.length > 0 || state.inflight !== null) && next.status !== "paused") {
    for (const meta of projection.turnMeta.values()) {
      if (meta.endedSeq === null || meta.endedSeq <= state.seenSeq) {
        continue;
      }
      if (meta.status === "failed") {
        next = pause(next, "turn_failed");
        break;
      }
      if (meta.status === "interrupted") {
        next = pause(next, "turn_interrupted");
        break;
      }
    }
  }

  if (next.inflight !== null) {
    const inflight = attributeInflight(next.inflight, projection);
    if (inflight.awaitingTurnId === null) {
      if (inflight.acceptedAt !== null && now - inflight.acceptedAt > ATTRIBUTION_DEADLINE_MS) {
        // 这一条去了哪儿还没确认：它在消息流里看得见，留给人处理；不回队、不重发。
        next = pause({ ...next, inflight: null }, "attribution_unconfirmed");
      } else if (inflight !== next.inflight) {
        next = { ...next, inflight };
      }
    } else {
      const meta = projection.turnMeta.get(inflight.awaitingTurnId);
      const ended =
        meta !== undefined && isTerminalStatus(meta.status) && meta.endedSeq !== null && meta.endedSeq > inflight.dequeueSeq;
      if (!ended) {
        next = inflight === next.inflight ? next : { ...next, inflight };
      } else if (meta.status === "completed") {
        next = { ...next, inflight: null };
        if (next.status !== "paused") {
          next = { ...next, status: hasSendable(next.items) ? "waiting" : "idle" };
        }
      } else {
        next = pause({ ...next, inflight: null }, meta.status === "interrupted" ? "turn_interrupted" : "turn_failed");
      }
    }
  }

  if (next.seenSeq !== projection.lastSeq) {
    next = { ...next, seenSeq: projection.lastSeq };
  }
  return next;
}

/** 由 clientTurnId 在投影里找真实回合（reducer 的归属映射）；找不到就原样返回。 */
function attributeInflight(inflight: QueueInflight, projection: ConversationProjection): QueueInflight {
  if (inflight.awaitingTurnId !== null || inflight.clientTurnId === null) {
    return inflight;
  }
  const message = projection.messages.find(
    (entry) => entry.role === "user" && entry.clientTurnId === inflight.clientTurnId,
  );
  return message?.turnId === null || message?.turnId === undefined
    ? inflight
    : { ...inflight, awaitingTurnId: message.turnId };
}

/** 从 sessionStorage 重建：有项就强制 paused（刷新 / 切回会话都要人确认继续），不清空。 */
export function loadQueue(sessionId: string, storage: Pick<Storage, "getItem"> | null = defaultStorage()): QueueState {
  if (storage === null) {
    return emptyQueue();
  }
  let stored: StoredQueue | null;
  try {
    const raw = storage.getItem(STORAGE_KEY_PREFIX + sessionId);
    stored = raw === null ? null : (JSON.parse(raw) as StoredQueue);
  } catch {
    stored = null;
  }
  const items = Array.isArray(stored?.items)
    ? stored.items.filter((item): item is QueueItem => typeof item?.id === "string" && typeof item.text === "string")
      .map((item) => ({
        ...item,
        attachmentIds: Array.isArray(item.attachmentIds) ? item.attachmentIds : [],
        ...(typeof item.skill?.name === "string" && typeof item.skill.path === "string"
          ? { skill: { name: item.skill.name, path: item.skill.path } }
          : {}),
      }))
      .map(({ skill, ...rest }) => (skill === undefined ? rest : { ...rest, skill }))
    : [];
  if (items.length === 0) {
    return emptyQueue();
  }
  return { items, status: "paused", pausedReason: "restored", inflight: null, seenSeq: null };
}

export function saveQueue(sessionId: string, state: QueueState, storage: Pick<Storage, "setItem" | "removeItem"> | null = defaultStorage()): void {
  if (storage === null) {
    return;
  }
  try {
    if (state.items.length === 0) {
      storage.removeItem(STORAGE_KEY_PREFIX + sessionId);
      return;
    }
    const stored: StoredQueue = {
      items: state.items,
      status: state.status,
      ...(state.pausedReason === null ? {} : { pausedReason: state.pausedReason }),
    };
    storage.setItem(STORAGE_KEY_PREFIX + sessionId, JSON.stringify(stored));
  } catch {
    // sessionStorage 不可用（隐私模式 / 配额）：队列退化为纯内存态，不打扰用户。
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** 队列出队与 Composer 发送共用同一套内容组装：skill → 文本 → 图片（高清）。 */
export function buildMessageContent(input: {
  text: string;
  skill: { name: string; path: string } | undefined;
  attachmentIds: readonly string[];
}): MessageContent[] {
  const text = input.text.trim();
  return [
    ...(input.skill ? [{ type: "skill" as const, name: input.skill.name, path: input.skill.path }] : []),
    ...(text ? [{ type: "text" as const, text }] : []),
    ...input.attachmentIds.map((attachmentId) => ({
      type: "local-image" as const,
      attachmentId,
      detail: "high" as const,
    })),
  ];
}
