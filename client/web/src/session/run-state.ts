import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import type { ConversationProjection, CurrentStep, TurnStatus } from "../event-projection/reducer.js";

/**
 * 运行态的本页内存态（PR3）：计时锚点与停止中间态。纯函数，SessionRuntime 只做接线。
 *
 * 计时基准（技术设计 §四.5）：事件的 `ts` 是 BFF 时钟，浏览器不能拿它算时长。只有本标签页
 * **实时**见过 `turn.started` 的回合才用本地 `Date.now()` 建锚点；开页前 / 重连前就在跑的回合
 * 只显示「运行中」，不显示时长。「实时」的证据是服务端在 SSE 回放结束时发的 `stream.live`
 * 控制帧：边界之后经实时入口收到的 `turn.started` 才建锚点；SSE 回放阶段与 HTTP 回填一律不建。
 * 禁止用 `Date.now() - event.ts` 阈值猜实时性（跨时钟）。
 */
export interface TimingState {
  /** 本条 SSE 连接是否已经过了回放边界。EventSource 报错（将自动重连）即作废，等下一个 stream.live。 */
  liveBoundary: boolean;
  /** turnId → 本地锚点（Date.now()）。 */
  anchors: ReadonlyMap<string, number>;
}

export const INITIAL_TIMING: TimingState = { liveBoundary: false, anchors: new Map() };

/** 服务端回放结束、切到实时：从这条帧起收到的 turn.started 才算本页实时见过。 */
export function onStreamLive(state: TimingState): TimingState {
  return state.liveBoundary ? state : { ...state, liveBoundary: true };
}

/**
 * 连接出错（浏览器随后自动重连并从头回放）：边界作废，但已建的锚点保留——
 * 那些回合本页确实实时见过它们开始。`error` 只是「边界作废」的信号，不是「已重连」的证明。
 */
export function onStreamReset(state: TimingState): TimingState {
  return state.liveBoundary ? { ...state, liveBoundary: false } : state;
}

/** 经实时入口（EventSource 消息回调）收到一条事件；HTTP 回填不走这里。 */
export function onLiveEvent(
  state: TimingState,
  event: EventEnvelope<string, JsonValue>,
  now: number,
): TimingState {
  if (!state.liveBoundary || event.type !== "turn.started" || !event.turnRef?.turnId) {
    return state;
  }
  if (state.anchors.has(event.turnRef.turnId)) {
    return state;
  }
  const anchors = new Map(state.anchors);
  anchors.set(event.turnRef.turnId, now);
  return { ...state, anchors };
}

/** 有锚点才有时长；没有就是 null（界面只显示「运行中」）。 */
export function elapsedFor(state: TimingState, turnId: string | null, now: number): number | null {
  if (turnId === null) {
    return null;
  }
  const anchor = state.anchors.get(turnId);
  return anchor === undefined ? null : Math.max(0, now - anchor);
}

/**
 * 停止中间态（技术设计 §四.3）：点停止立刻置位、控件禁用，不等远程返回；
 * 收到目标回合任一终态（含自然完成）才收口；请求本身失败则解除并如实报错。
 * `turn.interrupt-requested` 是远程调用返回后才入账的、必然可能迟到的事件——投影根本不消费它，
 * 所以它不可能把已终态的回合拉回 stopping。
 */
export interface StoppingState {
  turnId: string;
}

const TERMINAL: ReadonlySet<TurnStatus> = new Set(["completed", "interrupted", "failed"]);

export function isTerminalStatus(status: TurnStatus | undefined): boolean {
  return status !== undefined && TERMINAL.has(status);
}

/** 目标回合已终态 → 收口（返回 null）；否则保持。 */
export function reconcileStopping(
  stopping: StoppingState | null,
  projection: ConversationProjection,
): StoppingState | null {
  if (stopping === null) {
    return null;
  }
  return isTerminalStatus(projection.turnMeta.get(stopping.turnId)?.status) ? null : stopping;
}

export type StopIntent =
  | { kind: "interrupt"; turnId: string }
  /** 目标回合已经结束，而另有回合在跑：告知 + 提供「停止当前这一轮」，绝不自动中断新的一轮。 */
  | { kind: "mismatch"; endedTurnId: string; runningTurnId: string }
  /** 目标回合已经结束，也没有别的回合在跑：什么都不用做。 */
  | { kind: "noop"; endedTurnId: string };

/** 用户点停止那一刻，按最新投影决定要做什么。 */
export function resolveStopIntent(targetTurnId: string, projection: ConversationProjection): StopIntent {
  if (!isTerminalStatus(projection.turnMeta.get(targetTurnId)?.status)) {
    return { kind: "interrupt", turnId: targetTurnId };
  }
  const other = projection.runningTurnIds.find((turnId) => turnId !== targetTurnId);
  return other === undefined
    ? { kind: "noop", endedTurnId: targetTurnId }
    : { kind: "mismatch", endedTurnId: targetTurnId, runningTurnId: other };
}

/** 最近一个终态回合的结局（endedSeq 最大者），供顶栏走 sessionUiStatus 显示「已完成 / 异常」。 */
export function lastTurnOutcomeOf(
  projection: ConversationProjection,
): "completed" | "failed" | "interrupted" | null {
  let latest: { seq: number; status: TurnStatus } | null = null;
  for (const meta of projection.turnMeta.values()) {
    if (meta.endedSeq !== null && (latest === null || meta.endedSeq > latest.seq)) {
      latest = { seq: meta.endedSeq, status: meta.status };
    }
  }
  if (latest === null) {
    return null;
  }
  return latest.status === "completed" || latest.status === "failed" || latest.status === "interrupted"
    ? latest.status
    : null;
}

/** 状态行文案：当前步骤 → 「正在执行 pnpm test」这种人话；没有步骤时为 null。按步骤类型说，不看标题文字。 */
export function stepText(step: CurrentStep | null): string | null {
  if (step === null) {
    return null;
  }
  switch (step.kind) {
    case "command":
      return step.detail === "" ? "正在执行命令" : `正在执行 ${step.detail}`;
    case "file":
      return step.detail === "" ? "正在更新文件" : `正在更新 ${step.detail}`;
    case "thinking":
      return "正在思考";
    case "tool":
      return step.detail === "" ? `正在调用 ${step.title}` : `正在调用 ${step.title} · ${step.detail}`;
  }
}
