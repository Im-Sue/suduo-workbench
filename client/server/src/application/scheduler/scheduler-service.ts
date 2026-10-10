import type { SchedulerItemDto, SchedulerSnapshotDto } from "@suduo/client-contracts";
import type { SessionRepository } from "../../infrastructure/db/repositories/session-repository.js";
import { ApiError } from "../api-error.js";
import type { SchedulerItem, TurnScheduler } from "./turn-scheduler.js";

/**
 * 运行面板（多 Agent 协作 S8，需求 4.11）：本机运行中与排队中的回合，可「先跑这个」、取消排队、停止运行中的。
 * 停止运行中的回合走中断（与会话页的停止一样），回合结束后名额自然还回去。
 */
export class SchedulerService {
  constructor(
    private readonly deps: {
      scheduler: TurnScheduler;
      sessions: Pick<SessionRepository, "getById">;
      agentName(agentId: string): string;
      /** 本机所有 Agent（面板上没有回合的也列出上限）。 */
      agentIds(): string[];
      interrupt(sessionId: string, turnId: string): Promise<unknown>;
    },
  ) {}

  snapshot(): SchedulerSnapshotDto {
    const snapshot = this.deps.scheduler.snapshot(this.deps.agentIds());
    return {
      running: snapshot.running.map((item) => this.item(item)),
      queued: snapshot.queued.map((item) => this.item(item)),
      limits: snapshot.limits,
    };
  }

  promote(itemId: string): SchedulerSnapshotDto {
    if (!this.deps.scheduler.promote(itemId)) throw new ApiError(404, "NOT_FOUND", (t) => t.http.schedulerItemNotQueued);
    return this.snapshot();
  }

  /** 排队中的出队；运行中的中断它的回合。都不是（已经结束）时 404。 */
  async cancel(itemId: string): Promise<SchedulerSnapshotDto> {
    if (this.deps.scheduler.cancel(itemId)) return this.snapshot();
    const running = this.deps.scheduler.snapshot().running.find((item) => item.id === itemId);
    if (running === undefined) throw new ApiError(404, "NOT_FOUND", (t) => t.http.schedulerItemNotFound);
    if (running.turnId !== null) await this.deps.interrupt(running.sessionId, running.turnId);
    // 拿到名额、回合还在开：开起来就中断它（不然点了停止却没停）。
    else this.deps.scheduler.whenStarted(itemId, (turnId) => void this.deps.interrupt(running.sessionId, turnId).catch(() => undefined));
    return this.snapshot();
  }

  private item(item: SchedulerItem): SchedulerItemDto {
    return {
      id: item.id,
      sessionId: item.sessionId,
      sessionTitle: this.deps.sessions.getById(item.sessionId)?.title ?? item.label,
      agentId: item.agentId,
      agentName: this.deps.agentName(item.agentId),
      source: item.source,
      label: item.label,
      state: item.state,
      position: item.position,
      enqueuedAt: item.enqueuedAt,
      startedAt: item.startedAt,
    };
  }
}
