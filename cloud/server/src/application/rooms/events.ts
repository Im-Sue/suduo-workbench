import type {
  AgentDto,
  AgentRunSummaryDto,
  AgentShareDto,
  AgentShareRequestDto,
  RoomDto,
  RoomEventDto,
  RoomMessageDto,
} from "@suduo/cloud-contracts";

/** 还没分配序号的房间事件：服务返回，路由层在事务提交后交给 RealtimeHub 发布。 */
export type RoomEventDraft = Omit<RoomEventDto, "id" | "occurredAt">;

/** 写操作的结果 + 提交后要推送的房间事件。 */
export interface WithEvents<T> {
  value: T;
  events: RoomEventDraft[];
}

/**
 * 推送是广播（房间对所有人可见），`viewer` 只对请求人有意义：
 * 事件里的房间一律带「中性」视角（未读 0），客户端应保留自己缓存里的 viewer。
 */
export function broadcastRoom(room: RoomDto): RoomDto {
  return {
    ...room,
    viewer: {
      joined: room.kind === "project_default",
      lastReadSeq: 0,
      unreadCount: 0,
      mentionCount: 0,
    },
  };
}

export const roomEvent = {
  changed(room: RoomDto): RoomEventDraft {
    return { type: "room.changed", projectId: room.projectId, roomId: room.id, room: broadcastRoom(room) };
  },
  members(room: RoomDto): RoomEventDraft {
    return { type: "room.members", projectId: room.projectId, roomId: room.id, room: broadcastRoom(room) };
  },
  message(projectId: string, message: RoomMessageDto): RoomEventDraft {
    return { type: "room.message", projectId, roomId: message.roomId, message };
  },
  run(projectId: string, run: AgentRunSummaryDto): RoomEventDraft {
    return { type: "room.run", projectId, roomId: run.roomId, run };
  },
  shares(projectId: string, share: AgentShareDto): RoomEventDraft {
    return { type: "room.shares", projectId, roomId: share.roomId, share };
  },
  shareRequest(projectId: string, shareRequest: AgentShareRequestDto): RoomEventDraft {
    return { type: "room.share_request", projectId, roomId: shareRequest.roomId, shareRequest };
  },
  agentPresence(agent: AgentDto): RoomEventDraft {
    return { type: "agent.presence", projectId: null, roomId: null, agent };
  },
  userPresence(userId: string, online: boolean): RoomEventDraft {
    return { type: "user.presence", projectId: null, roomId: null, user: { id: userId, online } };
  },
};
