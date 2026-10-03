import type {
  AgentShareDto,
  AgentShareDuration,
  AgentShareRequestDto,
  CreateAgentShareRequestRequest,
  ListAgentShareRequestsResponse,
  ListAgentSharesResponse,
  OpenAgentShareRequest,
  ResolveAgentShareRequestRequest,
} from "@suduo/cloud-contracts";
import { insertAuditLog } from "../../infrastructure/audit-log.js";
import type { Database, QueryExecutor } from "../../infrastructure/database.js";
import type { AgentRepository } from "../../infrastructure/rooms/agent-repository.js";
import type { RoomRef, RoomRepository } from "../../infrastructure/rooms/room-repository.js";
import type { AgentRunRepository } from "../../infrastructure/rooms/run-repository.js";
import type { AgentShareRepository } from "../../infrastructure/rooms/share-repository.js";
import { requiredRow } from "../../infrastructure/rooms/sql.js";
import { notFound } from "../errors.js";
import { RUN_REASONS, SHARE_TODAY_MAX_AHEAD_MS, SHARE_TWO_HOURS_MS } from "./constants.js";
import { roomEvent, type RoomEventDraft, type WithEvents } from "./events.js";

/**
 * 共享与申请共享（模块「Agent」）。
 * 只有所有者能开 / 关自己 Agent 的共享、处理申请——这是授权，不是一致性守卫；不符一律 404。
 * 开着的共享 (Agent, 房间) 只有一条：再开 = 改时长；待处理申请 (房间, Agent, 申请人) 只有一条：重复申请返回它。
 */
export class AgentShareService {
  constructor(
    private readonly database: Database,
    private readonly rooms: RoomRepository,
    private readonly agents: AgentRepository,
    private readonly shares: AgentShareRepository,
    private readonly runs: AgentRunRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(roomId: string): Promise<ListAgentSharesResponse> {
    await this.rooms.requireRef(roomId);
    return { items: (await this.shares.listOpen(roomId)).map((record) => record.share) };
  }

  async open(actorId: string, roomId: string, request: OpenAgentShareRequest): Promise<WithEvents<AgentShareDto>> {
    const expiresAt = shareExpiry(request.duration, request.expiresAt, this.now());
    const opened = await this.database.transaction(async (client) => {
      const room = await this.rooms.requireRef(roomId, client);
      await this.requireOwnAgent(client, actorId, request.agentId);
      return this.openWithin(client, actorId, room, request.agentId, expiresAt);
    });
    return this.openedOutcome(opened);
  }

  /** 关闭：已关闭的原样返回（合并）。排队中的任务停掉，执行中的请求停止。 */
  async close(actorId: string, shareId: string): Promise<WithEvents<AgentShareDto>> {
    const closed = await this.database.transaction(async (client) => {
      const share = await this.shares.lock(client, shareId);
      if (share === null) throw notFound("共享");
      const agent = await this.agents.find(share.agent_id, client);
      if (agent === null || agent.ownerId !== actorId) throw notFound("共享");
      if (share.closed_at !== null) return { changed: false, runIds: [] as string[] };
      const room = await this.rooms.requireRef(share.room_id, client);
      await this.shares.close(client, shareId, "closed");
      const runIds = await this.runs.stopForShare(client, share.agent_id, share.room_id, RUN_REASONS.shareClosed);
      await insertAuditLog(client, {
        actorId,
        projectId: room.projectId,
        requirementId: room.requirementId,
        resourceType: "agent_share",
        resourceId: shareId,
        action: "agent_share.closed",
        before: shareAudit(share.agent_id, share.room_id, share.expires_at),
        after: { ...shareAudit(share.agent_id, share.room_id, share.expires_at), closedReason: "closed" },
      });
      return { changed: true, runIds };
    });
    const record = requiredRow((await this.shares.find(shareId)) ?? undefined);
    if (!closed.changed) return { value: record.share, events: [] };
    const events: RoomEventDraft[] = [roomEvent.shares(record.projectId, record.share)];
    for (const run of await this.runs.findMany(closed.runIds)) events.push(roomEvent.run(run.projectId, run.summary));
    return { value: record.share, events };
  }

  /** 扫描：到期的共享关闭（closed_reason=expired），像手动关闭一样停掉相关任务。到期没有操作人，不写审计。 */
  async expireDue(): Promise<RoomEventDraft[]> {
    const expired = await this.database.transaction(async (client) => {
      const closed = await this.shares.closeExpired(client);
      const runIds: string[] = [];
      for (const share of closed) {
        runIds.push(...(await this.runs.stopForShare(client, share.agent_id, share.room_id, RUN_REASONS.shareExpired)));
      }
      return { shareIds: closed.map((share) => share.id), runIds };
    });
    const events: RoomEventDraft[] = [];
    for (const shareId of expired.shareIds) {
      const record = await this.shares.find(shareId);
      if (record !== null) events.push(roomEvent.shares(record.projectId, record.share));
    }
    for (const run of await this.runs.findMany(expired.runIds)) events.push(roomEvent.run(run.projectId, run.summary));
    return events;
  }

  // ───────────────────────────── 申请共享 ─────────────────────────────

  async listRequests(roomId: string): Promise<ListAgentShareRequestsResponse> {
    await this.rooms.requireRef(roomId);
    return { items: (await this.shares.listPendingRequests(roomId)).map((record) => record.request) };
  }

  /** 申请共享：重复申请合并为同一条待处理（返回 created=false）。 */
  async createRequest(
    actorId: string,
    roomId: string,
    request: CreateAgentShareRequestRequest,
  ): Promise<WithEvents<{ request: AgentShareRequestDto; created: boolean }>> {
    const { id, created } = await this.database.transaction(async (client) => {
      await this.rooms.requireRef(roomId, client);
      if ((await this.agents.find(request.agentId, client)) === null) throw notFound("Agent");
      return this.shares.createRequest(client, { roomId, agentId: request.agentId, requesterId: actorId });
    });
    const record = requiredRow((await this.shares.findRequest(id)) ?? undefined);
    return {
      value: { request: record.request, created },
      events: created ? [roomEvent.shareRequest(record.projectId, record.request)] : [],
    };
  }

  /** 所有者处理申请：accept = 开启共享（时长缺省「今天」），ignore = 忽略。已处理过的原样返回。 */
  async resolveRequest(
    actorId: string,
    requestId: string,
    request: ResolveAgentShareRequestRequest,
  ): Promise<WithEvents<AgentShareRequestDto>> {
    const expiresAt = shareExpiry(request.duration ?? "today", request.expiresAt, this.now());
    const resolved = await this.database.transaction(async (client) => {
      const locked = await this.shares.lockRequest(client, requestId);
      const record = locked === null ? null : await this.shares.findRequest(requestId, client);
      if (record === null || record.ownerId !== actorId) throw notFound("申请");
      if (record.request.status !== "pending") return { opened: null, ignored: false, projectId: record.projectId };
      if (request.action === "ignore") {
        await this.shares.ignoreRequest(client, requestId);
        return { opened: null, ignored: true, projectId: record.projectId };
      }
      const room = await this.rooms.requireRef(record.request.roomId, client);
      const opened = await this.openWithin(client, actorId, room, record.agentId, expiresAt);
      return { opened, ignored: false, projectId: record.projectId };
    });
    const current = requiredRow((await this.shares.findRequest(requestId)) ?? undefined).request;
    if (resolved.opened !== null) {
      const outcome = await this.openedOutcome(resolved.opened);
      return { value: current, events: outcome.events };
    }
    return {
      value: current,
      events: resolved.ignored ? [roomEvent.shareRequest(resolved.projectId, current)] : [],
    };
  }

  /** 开共享（事务内）：已有开着的就改到期时间；有变化才写审计；这个 Agent 在该房间的待处理申请都算已开启。 */
  private async openWithin(
    client: QueryExecutor,
    actorId: string,
    room: RoomRef,
    agentId: string,
    expiresAt: Date | null,
  ): Promise<{ shareId: string; changed: boolean; acceptedRequestIds: string[] }> {
    const existing = await this.shares.lockOpen(client, agentId, room.id);
    const shareId = await this.shares.upsertOpen(client, agentId, room.id, expiresAt);
    const changed = existing === null || (existing.expires_at?.getTime() ?? null) !== (expiresAt?.getTime() ?? null);
    if (changed) {
      await insertAuditLog(client, {
        actorId,
        projectId: room.projectId,
        requirementId: room.requirementId,
        resourceType: "agent_share",
        resourceId: shareId,
        action: "agent_share.opened",
        before: existing === null ? null : shareAudit(agentId, room.id, existing.expires_at),
        after: shareAudit(agentId, room.id, expiresAt),
      });
    }
    const acceptedRequestIds = await this.shares.acceptPending(client, room.id, agentId);
    return { shareId, changed, acceptedRequestIds };
  }

  private async openedOutcome(opened: {
    shareId: string;
    changed: boolean;
    acceptedRequestIds: string[];
  }): Promise<WithEvents<AgentShareDto>> {
    const record = requiredRow((await this.shares.find(opened.shareId)) ?? undefined);
    const events: RoomEventDraft[] = opened.changed ? [roomEvent.shares(record.projectId, record.share)] : [];
    for (const requestId of opened.acceptedRequestIds) {
      const request = await this.shares.findRequest(requestId);
      if (request !== null) events.push(roomEvent.shareRequest(request.projectId, request.request));
    }
    return { value: record.share, events };
  }

  private async requireOwnAgent(client: QueryExecutor, actorId: string, agentId: string): Promise<void> {
    const agent = await this.agents.find(agentId, client);
    if (agent === null || agent.ownerId !== actorId) throw notFound("Agent");
  }
}

/**
 * 到期时间：两小时 = 现在 + 2h；今天 = 浏览器给的本地当天结束（只接受未来 24 小时内），
 * 否则服务端时区的当天结束；直到我关闭 = null。
 */
export function shareExpiry(duration: AgentShareDuration, requested: string | undefined, now: Date): Date | null {
  if (duration === "until_closed") return null;
  if (duration === "two_hours") return new Date(now.getTime() + SHARE_TWO_HOURS_MS);
  if (requested !== undefined) {
    const value = Date.parse(requested);
    if (Number.isFinite(value) && value > now.getTime() && value <= now.getTime() + SHARE_TODAY_MAX_AHEAD_MS) {
      return new Date(value);
    }
  }
  const endOfDay = new Date(now.getTime());
  endOfDay.setHours(23, 59, 59, 999);
  return endOfDay;
}

function shareAudit(agentId: string, roomId: string, expiresAt: Date | null): Record<string, unknown> {
  return { agentId, roomId, expiresAt: expiresAt?.toISOString() ?? null };
}
