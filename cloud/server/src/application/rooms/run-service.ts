import { randomUUID } from "node:crypto";
import type {
  AgentRunDetailDto,
  AgentRunProgressRequest,
  AgentRunSummaryDto,
  CompleteAgentRunRequest,
  FinishAgentRunRequest,
  ListAgentRunsQuery,
  ListAgentRunsResponse,
  StartAgentRunResponse,
} from "@suduo/cloud-contracts";
import type { Database, QueryExecutor } from "../../infrastructure/database.js";
import type { AgentRepository } from "../../infrastructure/rooms/agent-repository.js";
import type { MessageRepository } from "../../infrastructure/rooms/message-repository.js";
import type { RoomRepository } from "../../infrastructure/rooms/room-repository.js";
import type { AgentRunRepository, RunLockRow } from "../../infrastructure/rooms/run-repository.js";
import { requiredRow, stripNulDeep } from "../../infrastructure/rooms/sql.js";
import { notFound } from "../errors.js";
import { RUN_REASONS } from "./constants.js";
import { roomEvent, type RoomEventDraft, type WithEvents } from "./events.js";

const RETRYABLE = new Set(["failed", "stopped", "offline"]);

/**
 * Agent 任务（模块「Agent」）：远程只派任务、存结果，执行在所有者本机。
 * 状态迁移全部是「条件满足才改，不满足原样返回」（ADR-0004 合并，不报冲突）。
 * 授权：回写（start / progress / complete / finish）只有所有者；停止 = 触发人或所有者；重试 = 触发人。不符一律 404。
 */
export class AgentRunService {
  constructor(
    private readonly database: Database,
    private readonly rooms: RoomRepository,
    private readonly messages: MessageRepository,
    private readonly agents: AgentRepository,
    private readonly runs: AgentRunRepository,
  ) {}

  async list(query: ListAgentRunsQuery): Promise<ListAgentRunsResponse> {
    return {
      items: await this.runs.list({
        ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
        ...(query.status === undefined ? {} : { status: query.status }),
      }),
    };
  }

  async detail(runId: string): Promise<AgentRunDetailDto> {
    const run = await this.runs.detail(runId);
    if (run === null) throw notFound("Agent run");
    return run;
  }

  /**
   * 所有者本机开始：只把排队中改成执行中；已不是排队中时 started=false、返回现状，调用方跳过。
   * 开始前再看一次共享：发消息 / 重试读共享时没加锁，与关共享并发时，关共享那边看不到还没提交的排队任务。
   * 共享已不生效（已关闭 / 已到期 / 不再共享到这个房间）就把任务直接置为已停止「共享已关闭」，
   * started=false 并照常推送任务变化（状态迁移，不是拒绝）。
   */
  async start(actorId: string, runId: string): Promise<WithEvents<StartAgentRunResponse>> {
    const outcome = await this.database.transaction(async (client) => {
      const locked = await this.lockOwned(client, actorId, runId);
      if (locked.status !== "queued") return { started: false, changed: false };
      const availability = await this.agents.availability(client, locked.agent_id, locked.room_id);
      if (!availability.shared) {
        return { started: false, changed: await this.runs.requestStop(client, locked, RUN_REASONS.shareClosed) };
      }
      const started = await this.runs.start(client, runId);
      return { started, changed: started };
    });
    const run = await this.summary(runId);
    return {
      value: { run: run.summary, started: outcome.started },
      events: outcome.changed ? [roomEvent.run(run.projectId, run.summary)] : [],
    };
  }

  /**
   * 进度一句话（+ 可选执行过程）；只对执行中的任务生效。外部字符串写库前去掉 NUL（见 stripNul）。
   * 进度的 code / 参数（中英双语技术设计 §4.3）照收不校验取值：老本机不带时为 null，前端显示文字原文。
   */
  async progress(actorId: string, runId: string, raw: AgentRunProgressRequest): Promise<WithEvents<AgentRunSummaryDto>> {
    const request = stripNulDeep(raw);
    const changed = await this.database.transaction(async (client) => {
      await this.lockOwned(client, actorId, runId);
      return this.runs.progress(client, runId, {
        text: request.progress,
        code: request.progressCode ?? null,
        params: request.progressCode === undefined ? null : (request.progressParams ?? null),
        events: request.events,
      });
    });
    return this.outcome(runId, changed);
  }

  /**
   * 完成（一个事务）：以 Agent 名义（作者 = 所有者）在任务的话题下发回复、任务置已完成、记摘要与执行过程。
   * 已完成的原样返回（重复回写合并，不会发第二条回复）。房间归档后仍然收下回答，不丢。
   * 回答、摘要、执行过程写库前去掉 NUL。
   */
  async complete(actorId: string, runId: string, raw: CompleteAgentRunRequest): Promise<WithEvents<AgentRunSummaryDto>> {
    const request = stripNulDeep(raw);
    const completed = await this.database.transaction(async (client) => {
      const run = await this.lockOwned(client, actorId, runId);
      if (run.status === "completed") return null;
      await this.rooms.lock(client, run.room_id);
      const seq = await this.rooms.allocateSeq(client, run.room_id);
      const messageId = randomUUID();
      await this.messages.insert(client, {
        id: messageId,
        roomId: run.room_id,
        seq,
        clientId: null,
        authorKind: "agent",
        authorId: run.owner_id,
        agentId: run.agent_id,
        body: request.replyBody,
        mentions: [],
        threadRootId: run.thread_root_id,
      });
      await this.runs.complete(client, runId, {
        summary: request.summary,
        replyMessageId: messageId,
        events: request.events,
      });
      return messageId;
    });
    const run = await this.summary(runId);
    if (completed === null) return { value: run.summary, events: [] };
    const message = requiredRow((await this.messages.getById(completed)) ?? undefined);
    return {
      value: run.summary,
      events: [roomEvent.message(run.projectId, message), roomEvent.run(run.projectId, run.summary)],
    };
  }

  /**
   * 失败 / 已停止：已完成的不改；其余以所有者本机回写为准（原因的文字、code、参数整体覆盖）。
   * 原因与执行过程写库前去掉 NUL。
   */
  async finish(actorId: string, runId: string, raw: FinishAgentRunRequest): Promise<WithEvents<AgentRunSummaryDto>> {
    const request = stripNulDeep(raw);
    const changed = await this.database.transaction(async (client) => {
      const run = await this.lockOwned(client, actorId, runId);
      if (run.status === "completed") return false;
      await this.runs.finish(client, runId, {
        status: request.status,
        reason: {
          text: request.reason,
          code: request.reasonCode ?? null,
          params: request.reasonCode === undefined ? null : (request.reasonParams ?? null),
        },
        events: request.events,
      });
      return true;
    });
    return this.outcome(runId, changed);
  }

  /** 停止（触发人或所有者）：排队中 → 已停止；执行中 → stop_requested，本机中断后回写。 */
  async stop(actorId: string, runId: string): Promise<WithEvents<AgentRunSummaryDto>> {
    const changed = await this.database.transaction(async (client) => {
      const run = await this.runs.lock(client, runId);
      if (run === null || (run.triggered_by !== actorId && run.owner_id !== actorId)) throw notFound("Agent run");
      const reason = run.owner_id === actorId ? RUN_REASONS.stoppedByOwner : RUN_REASONS.stoppedByRequester;
      return this.runs.requestStop(client, run, reason);
    });
    return this.outcome(runId, changed);
  }

  /** 重试（触发人）：失败 / 已停止 / 离线 → 按共享与在线重新判定排队或离线，复用同一行。 */
  async retry(actorId: string, runId: string): Promise<WithEvents<AgentRunSummaryDto>> {
    const changed = await this.database.transaction(async (client) => {
      const run = await this.runs.lock(client, runId);
      if (run === null || run.triggered_by !== actorId) throw notFound("Agent run");
      if (!RETRYABLE.has(run.status)) return false;
      const availability = await this.agents.availability(client, run.agent_id, run.room_id);
      if (availability.shared && availability.online) {
        await this.runs.requeue(client, runId, "queued", null);
      } else {
        await this.runs.requeue(
          client,
          runId,
          "offline",
          availability.shared ? RUN_REASONS.ownerOffline : RUN_REASONS.notShared,
        );
      }
      return true;
    });
    return this.outcome(runId, changed);
  }

  /** 扫描：掉线 Agent 的排队任务改离线；执行中但本机超过 3 分钟没心跳的改失败。 */
  async sweepDisconnected(): Promise<RoomEventDraft[]> {
    const changedIds = await this.database.transaction(async (client) => [
      ...(await this.runs.offlineQueuedOfDisconnectedAgents(client, RUN_REASONS.ownerOffline)),
      ...(await this.runs.failRunningOfDisconnectedAgents(client, RUN_REASONS.ownerDisconnected)),
    ]);
    return (await this.runs.findMany(changedIds)).map((run) => roomEvent.run(run.projectId, run.summary));
  }

  private async lockOwned(client: QueryExecutor, actorId: string, runId: string): Promise<RunLockRow> {
    const run = await this.runs.lock(client, runId);
    if (run === null || run.owner_id !== actorId) throw notFound("Agent run");
    return run;
  }

  private async summary(runId: string) {
    return requiredRow((await this.runs.find(runId)) ?? undefined);
  }

  private async outcome(runId: string, changed: boolean): Promise<WithEvents<AgentRunSummaryDto>> {
    const run = await this.summary(runId);
    return { value: run.summary, events: changed ? [roomEvent.run(run.projectId, run.summary)] : [] };
  }
}
