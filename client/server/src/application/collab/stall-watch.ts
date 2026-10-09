import type { StallDto } from "@suduo/client-contracts";

/** 等你确认超过这么久提醒（技术设计 S8 遗留，S12 做）。 */
export const APPROVAL_STALL_MS = 10 * 60_000;
/** 回合在跑、这么久没有任何事件时提醒。 */
export const SILENT_STALL_MS = 15 * 60_000;

/**
 * 委派、评审的卡住提醒（多 Agent S12）：子会话 / 评审会话等你确认太久、或回合在跑却很久没动静时，在卡片上提醒一句
 * （运行面板列的是调度里的回合，不在那里提醒）。只提醒、不动它（ADR-0004：停不停由人决定）。最后一次事件的时间
 * 只在内存里（本机服务重启后从重启时算起）。
 */
export class StallWatch {
  private readonly lastEvent = new Map<string, number>();
  private readonly shown = new Map<string, string>();

  constructor(
    private readonly deps: {
      now(): number;
      /** 会话里最早一个还在等你确认的操作的时间；没有为 null。 */
      oldestApprovalAt(sessionId: string): number | null;
    },
  ) {}

  /** 跟着的会话来了一条事件。 */
  touch(id: string): void {
    this.lastEvent.set(id, this.deps.now());
  }

  forget(id: string): void {
    this.lastEvent.delete(id);
    this.shown.delete(id);
  }

  /** running：回合在跑（排队中等的是空位，不算没动静）。 */
  stalled(id: string, sessionId: string | null, running: boolean): StallDto | null {
    if (sessionId === null) return null;
    const now = this.deps.now();
    const approvalAt = this.deps.oldestApprovalAt(sessionId);
    if (approvalAt !== null) return now - approvalAt >= APPROVAL_STALL_MS ? { reason: "approval", since: approvalAt } : null;
    if (!running) return null;
    let last = this.lastEvent.get(id);
    if (last === undefined) {
      // 重启后第一次看到：从现在算起。
      last = now;
      this.lastEvent.set(id, last);
    }
    return now - last >= SILENT_STALL_MS ? { reason: "silent", since: last } : null;
  }

  /** 卡住与否（与原因）跟上次显示的不一样才需要刷新卡片；写卡片事件时也调一次，记下这次显示的。 */
  changed(id: string, stall: StallDto | null): boolean {
    const key = stall === null ? "" : stall.reason;
    if ((this.shown.get(id) ?? "") === key) return false;
    this.shown.set(id, key);
    return true;
  }
}
