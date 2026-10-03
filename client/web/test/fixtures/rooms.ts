import type {
  AgentDto,
  AgentRunSummaryDto,
  AgentShareDto,
  AgentShareRequestDto,
  RoomDto,
  RoomMemberDto,
  RoomMessageDto,
  UserSummaryDto,
} from "@suduo/cloud-contracts";

/** 房间测试共用的数据构造（契约 cloud/contracts/src/rooms.ts）。 */

export const ME: UserSummaryDto = { id: "u-me", displayName: "李娜" };
export const WANG: UserSummaryDto = { id: "u-wang", displayName: "小王" };
export const ZHANG: UserSummaryDto = { id: "u-zhang", displayName: "小张" };

export function room(patch: Partial<RoomDto> = {}): RoomDto {
  return {
    id: "room-1",
    projectId: "p1",
    kind: "project_default",
    name: "订单中心",
    requirement: null,
    lastSeq: 3,
    archivedAt: null,
    createdBy: null,
    createdAt: "2026-09-30T08:00:00.000Z",
    memberCount: 3,
    viewer: { joined: true, lastReadSeq: 3, unreadCount: 0, mentionCount: 0 },
    lastMessage: null,
    ...patch,
  };
}

export function agent(patch: Partial<AgentDto> = {}): AgentDto {
  const owner = patch.owner ?? WANG;
  return {
    id: "agent-wang",
    kind: "codex",
    owner,
    deviceName: "MacBook Pro",
    label: `${owner.displayName} 的 Codex · MacBook Pro`,
    online: true,
    lastSeenAt: "2026-09-30T09:00:00.000Z",
    activeShareCount: 1,
    ...patch,
  };
}

export function share(patch: Partial<AgentShareDto> = {}): AgentShareDto {
  return {
    id: "share-1",
    roomId: "room-1",
    agent: agent(),
    startedAt: "2026-09-30T08:30:00.000Z",
    expiresAt: null,
    closedAt: null,
    active: true,
    ...patch,
  };
}

export function shareRequest(patch: Partial<AgentShareRequestDto> = {}): AgentShareRequestDto {
  return {
    id: "req-1",
    roomId: "room-1",
    agent: agent(),
    requester: ME,
    status: "pending",
    createdAt: "2026-09-30T08:40:00.000Z",
    ...patch,
  };
}

export function run(patch: Partial<AgentRunSummaryDto> = {}): AgentRunSummaryDto {
  return {
    id: "run-1",
    roomId: "room-1",
    agent: agent(),
    triggerMessageId: "m-2",
    threadRootId: "m-2",
    triggeredBy: ME,
    status: "queued",
    queuePosition: null,
    progress: null,
    summary: null,
    replyMessageId: null,
    reason: null,
    stopRequested: false,
    createdAt: "2026-09-30T09:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...patch,
  };
}

export function message(patch: Partial<RoomMessageDto> = {}): RoomMessageDto {
  return {
    id: "m-1",
    roomId: "room-1",
    seq: 1,
    clientId: null,
    authorKind: "user",
    author: WANG,
    agent: null,
    body: "早",
    mentions: [],
    threadRootId: null,
    files: [],
    thread: null,
    runs: [],
    createdAt: "2026-09-30T09:00:00.000Z",
    ...patch,
  };
}

export function member(user: UserSummaryDto, online = true): RoomMemberDto {
  return { user, joinedAt: null, online };
}

export const signedInSettings = {
  configured: true,
  baseUrl: "https://requirements.example.com",
  session: { user: { ...ME, loginName: "lina", createdAt: "2026-08-01T00:00:00.000Z" }, expiresAt: "2026-12-01T00:00:00.000Z" },
  mappingCount: 1,
};
