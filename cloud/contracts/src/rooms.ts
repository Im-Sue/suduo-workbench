import type { UserSummaryDto } from "./auth.js";

/**
 * 项目聊天房间与共享 Agent（需求 suduo-v2-rooms-shared-agent-001）的远程契约。
 * 房间、消息、Agent、共享、任务全部存远程需求服务；Agent 在所有者本机执行。
 */

// ───────────────────────────── 房间 ─────────────────────────────

/** project_default = 项目默认房间（随项目存在，名称跟随项目，不能删除）；requirement = 需求下手动建的房间。 */
export const ROOM_KINDS = ["project_default", "requirement"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export interface RoomRequirementRefDto {
  id: string;
  number: number;
  title: string;
}

/** 当前用户在房间里的视角：未读、@ 我的未读。 */
export interface RoomViewerStateDto {
  /** 是否已是成员（项目默认房间对所有人恒为 true）。 */
  joined: boolean;
  lastReadSeq: number;
  unreadCount: number;
  /** 未读消息里 @ 了我（或 @ 所有人）的条数。 */
  mentionCount: number;
}

export interface RoomLastMessageDto {
  seq: number;
  /** 兜底文字（英文）：老客户端直接显示；新前端按下面的结构化字段用自己的语言渲染。 */
  authorName: string;
  /** 兜底文字（英文），同上。 */
  preview: string;
  createdAt: string;
  /**
   * 结构化的作者与预览（中英双语技术设计 §4.3）。老云端没有这些字段，前端缺省时退回上面的兜底文字。
   * authorKind 为 agent 时 agent 给所有者名与设备名，前端拼成本地化的 Agent 名。
   */
  authorKind?: RoomMessageAuthorKind;
  agent?: { ownerName: string; deviceName: string } | null;
  /** 正文压成一行、截过的预览；只有附件时为空串。 */
  text?: string;
  /** 第一个附件与附件总数（只有附件时前端据此给预览）。 */
  firstFile?: { fileName: string; kind: RoomFileKind } | null;
  fileCount?: number;
}

export interface RoomDto {
  id: string;
  projectId: string;
  kind: RoomKind;
  /** 项目默认房间 = 项目名；需求房间 = 自定的名字。 */
  name: string;
  requirement: RoomRequirementRefDto | null;
  /** 房间内消息的最大序号（每发一条 +1）。 */
  lastSeq: number;
  archivedAt: string | null;
  createdBy: UserSummaryDto | null;
  createdAt: string;
  memberCount: number;
  viewer: RoomViewerStateDto;
  lastMessage: RoomLastMessageDto | null;
}

export interface ListRoomsResponse {
  items: RoomDto[];
}

export interface CreateRequirementRoomRequest {
  /** 缺省为英文兜底「REQ-n room」；前端总会传按界面语言生成的名字。 */
  name?: string;
  /** 额外拉进来的人；创建人、需求负责人、需求创建人总是在内。 */
  memberIds?: string[];
}

export interface UpdateRoomRequest {
  name?: string;
  /** true 归档（只读，历史可看）；false 取消归档。 */
  archived?: boolean;
}

export interface RoomMemberDto {
  user: UserSummaryDto;
  /** 项目默认房间的成员是隐式的（全部用户），没有加入时间。 */
  joinedAt: string | null;
  /** 真人在线：打开着 SuDuo。 */
  online: boolean;
}

export interface ListRoomMembersResponse {
  items: RoomMemberDto[];
}

export interface AddRoomMembersRequest {
  /** 缺省 = 自己加入。 */
  userIds?: string[];
}

export interface MarkRoomReadRequest {
  /** 读到哪个序号（只会前进，回退请求按「已读位置不变」处理，不报错）。 */
  upToSeq: number;
}

// ───────────────────────────── 文件 ─────────────────────────────

export const ROOM_FILE_KINDS = ["image", "video", "file"] as const;
export type RoomFileKind = (typeof ROOM_FILE_KINDS)[number];

export interface RoomFileDto {
  id: string;
  roomId: string;
  fileName: string;
  contentType: string;
  kind: RoomFileKind;
  sizeBytes: number;
  sha256: string;
  uploadedBy: UserSummaryDto;
  createdAt: string;
}

/** 单个房间文件上限，沿用需求附件的 300MiB。 */
export const ROOM_FILE_MAX_BYTES = 314_572_800;

// ───────────────────────────── 消息 ─────────────────────────────

export const ROOM_MESSAGE_AUTHOR_KINDS = ["user", "agent", "system"] as const;
export type RoomMessageAuthorKind = (typeof ROOM_MESSAGE_AUTHOR_KINDS)[number];

/**
 * 消息里的 @：人、Agent、所有人（@ 所有人只提醒真人，不唤起 Agent）。
 * label 是发送时的兜底文字（all 为英文 everyone）；渲染与高亮按 kind，正文里 @所有人 / @everyone 都认。
 */
export type RoomMentionDto =
  | { kind: "user"; id: string; label: string }
  | { kind: "agent"; id: string; label: string }
  | { kind: "all"; id: null; label: string };

export type RoomMentionInput =
  | { kind: "user"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "all" };

export interface RoomThreadSummaryDto {
  replyCount: number;
  lastReplyAt: string | null;
  /** 最近回复的人（最多 3 个，去重）。 */
  lastRepliers: UserSummaryDto[];
}

export interface RoomMessageDto {
  id: string;
  roomId: string;
  seq: number;
  /** 发送端生成的 ID：网络重试时服务端按它合并，返回已有那条（ADR-0004 合并，不拒绝）。 */
  clientId: string | null;
  authorKind: RoomMessageAuthorKind;
  /** 真人作者；Agent 消息为所有者（以其名义展示「<所有者> 的 Codex」）。 */
  author: UserSummaryDto | null;
  agent: AgentSummaryDto | null;
  body: string;
  mentions: RoomMentionDto[];
  /** 话题根消息 ID；本身是根或普通消息时为 null。 */
  threadRootId: string | null;
  files: RoomFileDto[];
  /** 只在有回复的根消息上给出。 */
  thread: RoomThreadSummaryDto | null;
  /** 这条消息唤起的 Agent 任务（消息下的状态行）。 */
  runs: AgentRunSummaryDto[];
  createdAt: string;
}

export interface SendRoomMessageRequest {
  clientId: string;
  body: string;
  mentions?: RoomMentionInput[];
  threadRootId?: string | null;
  fileIds?: string[];
}

export interface ListRoomMessagesQuery {
  /** 取序号大于它的消息（断线补拉）。 */
  after?: number;
  /** 取序号小于它的消息（向上翻历史）。 */
  before?: number;
  /** 只取某个话题（根 + 回复）。 */
  threadRootId?: string;
  limit?: number;
}

export interface ListRoomMessagesResponse {
  items: RoomMessageDto[];
  /** 还有更早的消息。 */
  hasMoreBefore: boolean;
  /** 还有更新的消息（按 after 补拉时没取完）。 */
  hasMoreAfter: boolean;
  lastSeq: number;
}

/** `GET /v2/rooms/:roomId/messages/search`：正文包含关键词（不分大小写）的消息，最新的在后。 */
export interface SearchRoomMessagesQuery {
  q: string;
  /** 缺省 20，最多 50。 */
  limit?: number;
  /** 只找序号小于它的（继续往前翻）。 */
  before?: number;
}

/** 与按序号分页同形：hasMoreBefore = 更早还有匹配；hasMoreAfter 恒为 false。 */
export type SearchRoomMessagesResponse = ListRoomMessagesResponse;

// ───────────────────────────── Agent 与共享 ─────────────────────────────

export const AGENT_KINDS = ["codex"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** 列表、@ 选择框、消息作者等处用的 Agent 摘要。 */
export interface AgentSummaryDto {
  id: string;
  kind: AgentKind;
  owner: UserSummaryDto;
  deviceName: string;
  /**
   * 英文兜底「陈思远's Codex · MacBook Pro」，老客户端直接显示；新前端按所有者名与设备名用自己的语言拼。
   */
  label: string;
}

export interface AgentDto extends AgentSummaryDto {
  /** 所有者本机 SuDuo 在线（心跳未过期）且已登录。 */
  online: boolean;
  lastSeenAt: string | null;
  /** 开着的共享数（本机据此在共享期间保持常驻）。 */
  activeShareCount: number;
}

export interface RegisterAgentRequest {
  /** 本机安装的稳定标识（本机数据目录里生成一次）。同一所有者 + 设备重复登记返回同一个 Agent。 */
  deviceKey: string;
  deviceName: string;
  kind?: AgentKind;
}

export interface AgentHeartbeatRequest {
  /** 本机有没有打开着的 SuDuo 页面（真人在线）。 */
  browserActive: boolean;
}

export const AGENT_SHARE_DURATIONS = ["until_closed", "two_hours", "today"] as const;
export type AgentShareDuration = (typeof AGENT_SHARE_DURATIONS)[number];

export interface AgentShareDto {
  id: string;
  roomId: string;
  agent: AgentDto;
  startedAt: string;
  /** 到期时间；「直到我关闭」为 null。 */
  expiresAt: string | null;
  closedAt: string | null;
  /** 开着且未到期。 */
  active: boolean;
}

export interface ListAgentSharesResponse {
  items: AgentShareDto[];
}

export interface OpenAgentShareRequest {
  agentId: string;
  duration: AgentShareDuration;
  /** duration=today 时由浏览器给出本地当天结束时刻；服务端只接受未来 24 小时内的值，否则按服务端时区算。 */
  expiresAt?: string;
}

export const AGENT_SHARE_REQUEST_STATUSES = ["pending", "accepted", "ignored"] as const;
export type AgentShareRequestStatus = (typeof AGENT_SHARE_REQUEST_STATUSES)[number];

export interface AgentShareRequestDto {
  id: string;
  roomId: string;
  agent: AgentSummaryDto;
  requester: UserSummaryDto;
  status: AgentShareRequestStatus;
  createdAt: string;
}

export interface CreateAgentShareRequestRequest {
  agentId: string;
}

/** `GET /v2/rooms/:roomId/share-requests`：房间里待处理的申请。 */
export interface ListAgentShareRequestsResponse {
  items: AgentShareRequestDto[];
}

export interface ResolveAgentShareRequestRequest {
  /** accept = 一键开启共享（时长同 duration，缺省「今天」）；ignore = 忽略。 */
  action: "accept" | "ignore";
  duration?: AgentShareDuration;
  expiresAt?: string;
}

export interface ListAgentsResponse {
  items: AgentDto[];
}

// ───────────────────────────── Agent 任务 ─────────────────────────────

/** 任务进度、原因的参数：只放字符串与数字（各端按 code 取用，多出来的忽略）。 */
export type AgentRunTextParams = Record<string, string | number>;

export const AGENT_RUN_STATUSES = ["queued", "running", "completed", "failed", "stopped", "offline"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export interface AgentRunSummaryDto {
  id: string;
  roomId: string;
  agent: AgentSummaryDto;
  triggerMessageId: string;
  /** 回答挂在哪个话题下（触发消息本身或它所在话题的根）。 */
  threadRootId: string;
  triggeredBy: UserSummaryDto;
  status: AgentRunStatus;
  /** 排队时前面还有几个；其他状态为 null。 */
  queuePosition: number | null;
  /** 执行中的进度一句话（兜底文字，英文；新前端按 progressCode 渲染）。 */
  progress: string | null;
  /**
   * 结构化的进度与原因（中英双语技术设计 §4.3）：各人前端按自己的语言渲染，认不出的 code 退回文字。
   * 取值见 `AGENT_RUN_PROGRESS_CODES` / `AGENT_RUN_REASON_CODES`，类型故意放宽为 string：
   * 新版本加的 code 老版本照样能存、能转发。老云端没有这些字段，旧任务为 null。
   */
  progressCode?: string | null;
  progressParams?: AgentRunTextParams | null;
  /** 完成后的一句话摘要。 */
  summary: string | null;
  replyMessageId: string | null;
  /** 失败 / 停止 / 离线的原因（兜底文字，英文；新前端按 reasonCode 渲染）。 */
  reason: string | null;
  reasonCode?: string | null;
  reasonParams?: AgentRunTextParams | null;
  stopRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** 运行详情：完整执行过程（本机会话事件账本里这一回合的事件，已截断大输出）。 */
export interface AgentRunDetailDto extends AgentRunSummaryDto {
  /** `EventEnvelope[]`，前端用会话时间线同一套投影渲染。 */
  events: unknown[];
}

/** 所有者本机回写：开始执行（只有排队中的任务会被开始；已不是排队中时返回当前状态，调用方据此跳过）。 */
export interface StartAgentRunResponse {
  run: AgentRunSummaryDto;
  started: boolean;
}

export interface AgentRunProgressRequest {
  /** 兜底文字（英文）。 */
  progress: string;
  progressCode?: string;
  progressParams?: AgentRunTextParams;
  /** 截至目前的执行过程（可选；完成时一定会给）。 */
  events?: unknown[];
}

export interface CompleteAgentRunRequest {
  /** 完整回答（Markdown），作为话题回复发出。 */
  replyBody: string;
  summary: string;
  events: unknown[];
}

export interface FinishAgentRunRequest {
  status: "failed" | "stopped";
  /** 兜底文字（英文）。 */
  reason: string;
  reasonCode?: string;
  reasonParams?: AgentRunTextParams;
  events?: unknown[];
}

export interface ListAgentRunsQuery {
  agentId?: string;
  status?: AgentRunStatus;
}

export interface ListAgentRunsResponse {
  items: AgentRunSummaryDto[];
}

// ───────────────────────────── 实时 ─────────────────────────────

/**
 * 房间事件走同一条 `/v2/events`，SSE 事件名为 `room`（与需求事件的默认 message 分开，
 * 旧客户端不受影响）。事件带内容；`id` 是服务进程内单调递增的序号，断线重连时用
 * `Last-Event-ID` 补发最近一段，超出窗口时客户端按房间序号 `after` 补拉。
 */
export const ROOM_EVENT_TYPES = [
  "room.changed",
  "room.message",
  "room.run",
  "room.members",
  "room.shares",
  "room.share_request",
  "agent.presence",
  "user.presence",
] as const;
export type RoomEventType = (typeof ROOM_EVENT_TYPES)[number];

export interface RoomEventDto {
  id: number;
  type: RoomEventType;
  projectId: string | null;
  roomId: string | null;
  room?: RoomDto;
  message?: RoomMessageDto;
  run?: AgentRunSummaryDto;
  share?: AgentShareDto;
  shareRequest?: AgentShareRequestDto;
  agent?: AgentDto;
  user?: { id: string; online: boolean };
  occurredAt: string;
}

/** SSE 事件名。 */
export const ROOM_SSE_EVENT_NAME = "room";
