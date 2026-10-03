import type { AgentRepository } from "../../infrastructure/rooms/agent-repository.js";
import { ROOM_SWEEP_INTERVAL_MS } from "./constants.js";
import { roomEvent, type RoomEventDraft } from "./events.js";
import type { PresenceTracker } from "./presence-tracker.js";
import type { RealtimeHub } from "./realtime-hub.js";
import type { AgentRunService } from "./run-service.js";
import type { AgentShareService } from "./share-service.js";

export interface SweepResult {
  expiredShares: number;
  runsChanged: number;
  agentsOffline: number;
  usersOffline: number;
}

interface SweepLogger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
}

/**
 * 远程每 30 秒扫一次（进程内定时，服务关闭时停）：
 * 到期共享关闭并停任务；掉线 Agent 的排队任务改离线；执行中但本机 3 分钟没心跳的改失败；
 * 在线状态变化（超时下线）推 `agent.presence` / `user.presence`。每次变化都推房间事件。
 */
export class RoomSweeper {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SweepResult> | null = null;

  constructor(
    private readonly shares: AgentShareService,
    private readonly runs: AgentRunService,
    private readonly agents: AgentRepository,
    private readonly presence: PresenceTracker,
    private readonly realtime: RealtimeHub,
    private readonly logger: SweepLogger | null = null,
  ) {}

  start(intervalMs: number = ROOM_SWEEP_INTERVAL_MS): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logger?.warn({ error }, "room sweep failed");
      });
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** 跑一次（同时只跑一个；正在跑时等它结束并返回它的结果）。 */
  runOnce(): Promise<SweepResult> {
    this.running ??= this.sweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async sweep(): Promise<SweepResult> {
    const shareEvents = await this.shares.expireDue();
    const runEvents = await this.runs.sweepDisconnected();
    const presenceEvents: RoomEventDraft[] = [];
    const agentsOffline = this.presence.reconcileAgents(await this.agents.onlineAgentIds());
    for (const agentId of agentsOffline) {
      const record = await this.agents.find(agentId);
      if (record !== null) presenceEvents.push(roomEvent.agentPresence(record.agent));
    }
    const usersOffline = this.presence.reconcileUsers(await this.agents.onlineUserIds());
    for (const userId of usersOffline) presenceEvents.push(roomEvent.userPresence(userId, false));
    this.realtime.publishAll([...shareEvents, ...runEvents, ...presenceEvents]);
    const result: SweepResult = {
      expiredShares: shareEvents.filter((event) => event.type === "room.shares").length,
      runsChanged: runEvents.length + shareEvents.filter((event) => event.type === "room.run").length,
      agentsOffline: agentsOffline.length,
      usersOffline: usersOffline.length,
    };
    if (result.expiredShares + result.runsChanged + result.agentsOffline + result.usersOffline > 0) {
      this.logger?.info({ ...result }, "room sweep");
    }
    return result;
  }
}
