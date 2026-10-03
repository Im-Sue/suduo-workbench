import { randomUUID } from "node:crypto";
import {
  ROOM_MESSAGE_PAGE_DEFAULT_LIMIT,
  ROOM_MESSAGE_SEARCH_DEFAULT_LIMIT,
  type ListRoomMessagesQuery,
  type ListRoomMessagesResponse,
  type RoomMentionDto,
  type RoomMentionInput,
  type RoomMessageDto,
  type SearchRoomMessagesQuery,
  type SearchRoomMessagesResponse,
  type SendRoomMessageRequest,
} from "@suduo/cloud-contracts";
import type { Database, QueryExecutor } from "../../infrastructure/database.js";
import type { AgentRepository } from "../../infrastructure/rooms/agent-repository.js";
import type { RoomFileRepository } from "../../infrastructure/rooms/file-repository.js";
import type { MessageRepository } from "../../infrastructure/rooms/message-repository.js";
import type { RoomRepository } from "../../infrastructure/rooms/room-repository.js";
import type { AgentRunRepository } from "../../infrastructure/rooms/run-repository.js";
import { requiredRow, stripNul } from "../../infrastructure/rooms/sql.js";
import { ApplicationError, notFound } from "../errors.js";
import { MENTION_ALL_LABEL, RUN_REASONS } from "./constants.js";
import { roomEvent, type RoomEventDraft, type WithEvents } from "./events.js";

export interface SendRoomMessageResult {
  message: RoomMessageDto;
  /** false = 按客户端 ID 合并到了已有消息（HTTP 200）。 */
  created: boolean;
}

/**
 * 消息（模块「消息」）：分页、搜索、发送（按客户端 ID 合并网络重试）、@ Agent 建任务。
 */
export class RoomMessageService {
  constructor(
    private readonly database: Database,
    private readonly rooms: RoomRepository,
    private readonly messages: MessageRepository,
    private readonly files: RoomFileRepository,
    private readonly agents: AgentRepository,
    private readonly runs: AgentRunRepository,
  ) {}

  async list(roomId: string, query: ListRoomMessagesQuery): Promise<ListRoomMessagesResponse> {
    const room = await this.rooms.requireRef(roomId);
    if (query.threadRootId !== undefined && !(await this.messages.existsInRoom(roomId, query.threadRootId))) {
      throw notFound("话题");
    }
    const page = await this.messages.page(roomId, {
      limit: query.limit ?? ROOM_MESSAGE_PAGE_DEFAULT_LIMIT,
      ...(query.after === undefined ? {} : { after: query.after }),
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.threadRootId === undefined ? {} : { threadRootId: query.threadRootId }),
    });
    return { ...page, lastSeq: room.lastSeq };
  }

  async search(roomId: string, query: SearchRoomMessagesQuery): Promise<SearchRoomMessagesResponse> {
    const room = await this.rooms.requireRef(roomId);
    const q = stripNul(query.q).trim();
    if (q === "") throw new ApplicationError(400, "VALIDATION_ERROR", "关键词不能为空", { field: "q" });
    const page = await this.messages.search(roomId, {
      q,
      limit: query.limit ?? ROOM_MESSAGE_SEARCH_DEFAULT_LIMIT,
      ...(query.before === undefined ? {} : { before: query.before }),
    });
    return { ...page, lastSeq: room.lastSeq };
  }

  /**
   * 发消息（一个事务）：
   * 锁房间行 → 已有 (房间, 客户端 ID) 就返回那一条（合并，不重复建任务）→
   * 分配序号、插消息、关联文件、话题根计数 → 发送人加入（需求房间）并已读到本条 →
   * 每个 @Agent 建任务：共享开着且在线 = 排队，否则离线（离线不补跑，需求 R11）。
   * 已归档的房间照常收下（含 @ 建任务，与未归档一致）：界面对归档房间只读，能到这里的只有界面没刷新时晚到的消息；
   * 拿掉拒绝最坏只是消息进了已归档房间，人可以取消归档，够不上 ADR-0004 的红线。
   * 正文与客户端 ID 写库前去掉 NUL（见 stripNul），只含 NUL 的正文按空消息处理。
   */
  async send(actorId: string, roomId: string, raw: SendRoomMessageRequest): Promise<WithEvents<SendRoomMessageResult>> {
    const request = { ...raw, clientId: stripNul(raw.clientId), body: stripNul(raw.body) };
    if (request.clientId === "") {
      throw new ApplicationError(400, "VALIDATION_ERROR", "客户端 ID 不能为空", { field: "clientId" });
    }
    const outcome = await this.database.transaction(async (client) => {
      const room = await this.rooms.lock(client, roomId);
      const existingId = await this.messages.findIdByClientId(client, roomId, request.clientId);
      if (existingId !== null) {
        return { created: false as const, messageId: existingId, projectId: room.projectId };
      }
      const fileIds = [...new Set(request.fileIds ?? [])];
      if (request.body.trim() === "" && fileIds.length === 0) {
        throw new ApplicationError(400, "VALIDATION_ERROR", "消息不能为空", { field: "body" });
      }
      const threadRootId = request.threadRootId == null
        ? null
        : await this.messages.resolveThreadRoot(client, roomId, request.threadRootId);
      if (request.threadRootId != null && threadRootId === null) {
        throw new ApplicationError(400, "VALIDATION_ERROR", "话题不在这个房间里", { field: "threadRootId" });
      }
      const inRoom = await this.files.idsInRoom(client, roomId, fileIds);
      const foreign = fileIds.filter((id) => !inRoom.has(id));
      if (foreign.length > 0) {
        throw new ApplicationError(400, "VALIDATION_ERROR", "文件不属于这个房间", { field: "fileIds", fileIds: foreign });
      }
      const mentions = await this.resolveMentions(client, request.mentions ?? []);
      const seq = await this.rooms.allocateSeq(client, roomId);
      const messageId = randomUUID();
      await this.messages.insert(client, {
        id: messageId,
        roomId,
        seq,
        clientId: request.clientId,
        authorKind: "user",
        authorId: actorId,
        agentId: null,
        body: request.body,
        mentions,
        threadRootId,
      });
      await this.messages.linkFiles(client, messageId, fileIds);
      const joined = room.kind === "requirement"
        ? (await this.rooms.addMembers(client, roomId, [actorId])).length > 0
        : false;
      await this.rooms.recordRead(client, room, actorId, seq);
      for (const mention of mentions) {
        if (mention.kind !== "agent") continue;
        const availability = await this.agents.availability(client, mention.id, roomId);
        const status = availability.shared && availability.online ? "queued" : "offline";
        await this.runs.insert(client, {
          roomId,
          agentId: mention.id,
          triggerMessageId: messageId,
          threadRootId: threadRootId ?? messageId,
          triggeredBy: actorId,
          status,
          reason: status === "queued" ? null : availability.shared ? RUN_REASONS.ownerOffline : RUN_REASONS.notShared,
        });
      }
      return { created: true as const, messageId, projectId: room.projectId, joined };
    });
    const message = requiredRow((await this.messages.getById(outcome.messageId)) ?? undefined);
    if (!outcome.created) return { value: { message, created: false }, events: [] };
    const events: RoomEventDraft[] = [roomEvent.message(outcome.projectId, message)];
    for (const run of message.runs) events.push(roomEvent.run(outcome.projectId, run));
    if (outcome.joined) events.push(roomEvent.members(await this.rooms.getRoom(roomId, null)));
    return { value: { message, created: true }, events };
  }

  /** @ 的对象必须存在（输入校验）；去重；展示文字由服务端按用户名 / Agent 标签生成。 */
  private async resolveMentions(executor: QueryExecutor, inputs: readonly RoomMentionInput[]): Promise<RoomMentionDto[]> {
    const userIds = inputs.flatMap((mention) => (mention.kind === "user" ? [requiredMentionId(mention)] : []));
    const agentIds = inputs.flatMap((mention) => (mention.kind === "agent" ? [requiredMentionId(mention)] : []));
    const users = await this.userNames(executor, userIds);
    const agents = await this.agents.labels(executor, agentIds);
    const missing = [
      ...userIds.filter((id) => !users.has(id.toLowerCase())),
      ...agentIds.filter((id) => !agents.has(id.toLowerCase())),
    ];
    if (missing.length > 0) {
      throw new ApplicationError(400, "VALIDATION_ERROR", "@ 的人或 Agent 不存在", { field: "mentions", ids: missing });
    }
    const seen = new Set<string>();
    const result: RoomMentionDto[] = [];
    for (const mention of inputs) {
      if (mention.kind === "all") {
        if (seen.has("all")) continue;
        seen.add("all");
        result.push({ kind: "all", id: null, label: MENTION_ALL_LABEL });
        continue;
      }
      const id = requiredMentionId(mention).toLowerCase();
      const key = `${mention.kind}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(
        mention.kind === "user"
          ? { kind: "user", id, label: users.get(id) ?? "" }
          : { kind: "agent", id, label: agents.get(id) ?? "" },
      );
    }
    return result;
  }

  private async userNames(executor: QueryExecutor, userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const result = await executor.query<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])",
      [[...new Set(userIds)]],
    );
    return new Map(result.rows.map((row) => [row.id, row.display_name]));
  }
}

function requiredMentionId(mention: RoomMentionInput): string {
  if (mention.kind === "all") return "";
  const id = (mention as { id?: unknown }).id;
  if (typeof id !== "string" || id === "") {
    throw new ApplicationError(400, "VALIDATION_ERROR", "@ 人或 Agent 时必须给出 ID", { field: "mentions" });
  }
  return id;
}
