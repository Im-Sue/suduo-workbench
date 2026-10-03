import type {
  AgentDto,
  AgentHeartbeatRequest,
  ListAgentsResponse,
  RegisterAgentRequest,
} from "@suduo/cloud-contracts";
import type { AgentRepository } from "../../infrastructure/rooms/agent-repository.js";
import { requiredRow, stripNul } from "../../infrastructure/rooms/sql.js";
import { notFound } from "../errors.js";
import { roomEvent, type RoomEventDraft, type WithEvents } from "./events.js";
import type { PresenceTracker } from "./presence-tracker.js";

/**
 * Agent 登记、心跳与在线（模块「Agent」）。
 * Agent = 某人某台电脑上的 Codex；在线 = 90 秒内有心跳。真人在线由心跳里的 browserActive 报告。
 */
export class AgentService {
  constructor(
    private readonly agents: AgentRepository,
    private readonly presence: PresenceTracker,
  ) {}

  async list(): Promise<ListAgentsResponse> {
    return { items: await this.agents.list() };
  }

  /**
   * 登记：同一所有者 + 设备 + 类型合并为同一个 Agent，更新设备名（ADR-0004 合并）。
   * 设备标识与设备名写库前去掉 NUL（见 stripNul）。
   */
  async register(ownerId: string, request: RegisterAgentRequest): Promise<WithEvents<{ agent: AgentDto; created: boolean }>> {
    const deviceKey = stripNul(request.deviceKey).trim();
    const { agentId, created } = await this.agents.register({
      ownerId,
      deviceKey,
      deviceName: stripNul(request.deviceName).trim() || deviceKey,
      kind: request.kind ?? "codex",
    });
    const agent = requiredRow((await this.agents.find(agentId)) ?? undefined).agent;
    const events = this.presence.markAgentOnline(agent.id) ? [roomEvent.agentPresence(agent)] : [];
    return { value: { agent, created }, events };
  }

  /** 心跳：只有所有者能发；别人的 Agent 一律 404。 */
  async heartbeat(ownerId: string, agentId: string, request: AgentHeartbeatRequest): Promise<WithEvents<AgentDto>> {
    if (!(await this.agents.touch(agentId, ownerId))) throw notFound("Agent");
    const events: RoomEventDraft[] = [];
    if (request.browserActive) {
      await this.agents.touchUserPresence(ownerId);
      if (this.presence.markUserOnline(ownerId)) events.push(roomEvent.userPresence(ownerId, true));
    }
    const agent = requiredRow((await this.agents.find(agentId)) ?? undefined).agent;
    if (this.presence.markAgentOnline(agentId)) events.unshift(roomEvent.agentPresence(agent));
    return { value: agent, events };
  }
}
