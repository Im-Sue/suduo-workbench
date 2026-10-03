import type { SessionDto, SessionRunStatusDto } from "@suduo/client-contracts";

/**
 * 会话状态灯的判定与文案。
 *
 * 从 `LeftRail.tsx` 提取到这里（pr8）：它是**会话域逻辑**，不是 UI 原语，
 * 所以不进 `components/ui/`。`LeftRail` 本体在替代物上线后由本片删除，
 * 但这段判定要留下来给 `SessionsRail` 与会话头共用。
 */
export type SessionUiStatus =
  | "running"
  | "approval"
  | "completed"
  | "idle"
  | "error";

/**
 * 会话头徽章 / 状态行 / 侧栏状态灯共用的唯一判定（PR3 起顶栏也走这里）。
 * 选中会话传 SSE 实时值，并可用投影推出的 `lastTurnOutcome` 让顶栏显示「已完成 / 异常」；
 * 其余会话由运行态摘要（10s 轮询）兜底。
 */
export function sessionUiStatus(
  session: SessionDto,
  running: number,
  pending: number,
  summary?: Partial<Pick<SessionRunStatusDto, "running" | "pendingApprovals" | "lastTurnOutcome">>,
): SessionUiStatus {
  if (session.state === "error") {
    return "error";
  }
  if (pending > 0 || (summary?.pendingApprovals ?? 0) > 0) {
    return "approval";
  }
  if (running > 0 || summary?.running === true) {
    return "running";
  }
  if (summary?.lastTurnOutcome === "failed") {
    return "error";
  }
  if (summary?.lastTurnOutcome === "completed") {
    return "completed";
  }
  return "idle";
}

/**
 * 选中会话由 SessionRuntime 经 SSE 实时得到的运行态（PR4 实时通道）。
 * 侧栏选中行只吃它、不再看 10s 轮询摘要——`sessionUiStatus` 对 running 是 OR 语义，
 * 同时传两者时旧摘要的 running:true 会把实时的「空闲 / 已完成」盖回「运行中」。
 */
export interface SessionLiveRunState {
  sessionId: string;
  running: number;
  pendingApprovals: number;
  lastTurnOutcome: SessionRunStatusDto["lastTurnOutcome"];
}

/**
 * 侧栏一行的状态：不是第二个判定函数，只是选输入源——属于本行的实时值优先，
 * 否则用轮询摘要兜底；判定本身仍是 `sessionUiStatus`。
 */
export function sessionRowStatus(
  session: SessionDto,
  live: SessionLiveRunState | undefined,
  summary: SessionRunStatusDto | undefined,
): SessionUiStatus {
  if (live !== undefined && live.sessionId === session.id) {
    return sessionUiStatus(session, live.running, live.pendingApprovals, { lastTurnOutcome: live.lastTurnOutcome });
  }
  return sessionUiStatus(session, 0, 0, summary);
}

export const SESSION_STATUS_LABEL: Record<SessionUiStatus, string> = {
  running: "运行中",
  approval: "等你确认",
  completed: "已完成",
  idle: "空闲",
  error: "异常",
};

/** 状态灯颜色：与需求看板的审计色调同一套语义，避免两处各造一份。 */
export const SESSION_STATUS_DOT_CLASS: Record<SessionUiStatus, string> = {
  running: "bg-[var(--ok)] animate-pulse",
  approval: "bg-[var(--warn)]",
  completed: "bg-[var(--ok)]",
  idle: "bg-[var(--border-strong)]",
  error: "bg-destructive",
};
