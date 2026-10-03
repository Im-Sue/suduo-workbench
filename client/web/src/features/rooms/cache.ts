import type { QueryClient } from "@tanstack/react-query";
import type { LocalAgentStateDto } from "@suduo/client-contracts";
import type {
  AgentDto,
  AgentRunSummaryDto,
  AgentShareDto,
  AgentShareRequestDto,
  ListAgentShareRequestsResponse,
  ListAgentSharesResponse,
  ListAgentsResponse,
  ListRoomMembersResponse,
  ListRoomsResponse,
  RoomDto,
  RoomMessageDto,
  RoomViewerStateDto,
} from "@suduo/cloud-contracts";
import type { RequirementsSettingsDto } from "../../api/client.js";
import { queryKeys } from "../../app/queries.js";
import { roomKeys } from "./keys.js";
import { applyRunToMessages, mergeMessages, roomAfterMessage, roomAfterRead, type MessagesData } from "./model.js";

/**
 * 房间数据写缓存的唯一出口：实时事件、发送回执、补拉都走这里，合并规则只有一套。
 * 推送带内容（技术设计 §三），所以这里直接 setQueryData，不靠失效重取。
 */

export function meIdOf(queryClient: QueryClient): string | null {
  return queryClient.getQueryData<RequirementsSettingsDto>(queryKeys.settings)?.session?.user.id ?? null;
}

// ---------- 「正在看」：在看这个房间且停在底部时，新消息不算未读（马上会记已读） ----------

/**
 * 同一个房间可能同时开在讨论页和悬浮窗口里：按「谁在看」分别登记，任一处在看就算在看，
 * 一处关掉不影响另一处。不传 viewer 时用同一个缺省登记（单处使用、测试）。
 */
const DEFAULT_VIEWER = {};
const reading = new Map<string, Set<object>>();

export function setReadingRoom(roomId: string, value: boolean, viewer: object = DEFAULT_VIEWER): void {
  const viewers = reading.get(roomId);
  if (value) {
    if (viewers === undefined) reading.set(roomId, new Set([viewer]));
    else viewers.add(viewer);
    return;
  }
  if (viewers === undefined) return;
  viewers.delete(viewer);
  if (viewers.size === 0) reading.delete(roomId);
}

export function isReadingRoom(roomId: string): boolean {
  return (reading.get(roomId)?.size ?? 0) > 0;
}

// ---------- 未读的本地累加：按消息 id 去重 ----------

/**
 * 推送可能乱序（较早的一条晚到），房间广播里的最大序号也可能先于消息到达，所以「这条算没算过未读」不能比房间最大序号。
 * 每份缓存（QueryClient）按房间记两样：
 * - serverSeq：最近一次从服务端取房间列表时它的最大序号——服务端给的未读已经算到这里（重连补发的旧消息据此不重复加）；
 * - seen：之后本地处理过的消息 id → 序号（serverSeq 前进后，落在它之内的就可以忘掉）。
 */
interface UnreadLedger {
  serverSeq: number;
  seen: Map<string, number>;
}

const SEEN_LIMIT = 1_000;
const ledgers = new WeakMap<QueryClient, Map<string, UnreadLedger>>();

function ledgerOf(queryClient: QueryClient, roomId: string): UnreadLedger {
  let rooms = ledgers.get(queryClient);
  if (rooms === undefined) {
    rooms = new Map();
    ledgers.set(queryClient, rooms);
  }
  let ledger = rooms.get(roomId);
  if (ledger === undefined) {
    ledger = { serverSeq: 0, seen: new Map() };
    rooms.set(roomId, ledger);
  }
  return ledger;
}

/** 房间列表从服务端取回后调用（原样返回）：记下各房间的未读已经算到哪个序号。 */
export function noteServerRooms(queryClient: QueryClient, response: ListRoomsResponse): ListRoomsResponse {
  for (const room of response.items) {
    const ledger = ledgerOf(queryClient, room.id);
    ledger.serverSeq = Math.max(ledger.serverSeq, room.lastSeq);
    for (const [id, seq] of ledger.seen) if (seq <= ledger.serverSeq) ledger.seen.delete(id);
  }
  return response;
}

/** 这条消息是不是第一次到：服务端给的列表没算过它（序号在记下的之后），本地也没处理过。是就记下。 */
function firstArrival(queryClient: QueryClient, message: RoomMessageDto): boolean {
  const ledger = ledgerOf(queryClient, message.roomId);
  if (message.seq <= ledger.serverSeq || ledger.seen.has(message.id)) return false;
  ledger.seen.set(message.id, message.seq);
  // 很久没刷新列表时只留最近的一批（Map 按插入顺序，先删最早的）。
  if (ledger.seen.size > SEEN_LIMIT) {
    const oldest = ledger.seen.keys().next().value;
    if (oldest !== undefined) ledger.seen.delete(oldest);
  }
  return true;
}

// ---------- 房间 ----------

/** 改房间列表与详情里的同一个房间。 */
export function patchRoom(queryClient: QueryClient, roomId: string, update: (room: RoomDto) => RoomDto): void {
  for (const [key, data] of queryClient.getQueriesData<ListRoomsResponse>({ queryKey: roomKeys.lists })) {
    if (data === undefined || !data.items.some((room) => room.id === roomId)) continue;
    queryClient.setQueryData<ListRoomsResponse>(key, { ...data, items: data.items.map((room) => (room.id === roomId ? update(room) : room)) });
  }
  const detail = queryClient.getQueryData<RoomDto>(roomKeys.detail(roomId));
  if (detail !== undefined) queryClient.setQueryData<RoomDto>(roomKeys.detail(roomId), update(detail));
}

export function findCachedRoom(queryClient: QueryClient, roomId: string): RoomDto | undefined {
  const detail = queryClient.getQueryData<RoomDto>(roomKeys.detail(roomId));
  if (detail !== undefined) return detail;
  for (const [, data] of queryClient.getQueriesData<ListRoomsResponse>({ queryKey: roomKeys.lists })) {
    const found = data?.items.find((room) => room.id === roomId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 房间本身变了（新建、改名、归档）：列表与详情里替换；新房间加到所属项目 / 需求的列表里。
 * 「我的视角」（未读、是否加入）是个人状态：推送是广播，里面的 viewer 是中性值，保留本地已有的。
 */
export function upsertRoom(queryClient: QueryClient, room: RoomDto): void {
  const keep = (existing: RoomDto | undefined): RoomDto => (existing === undefined ? room : { ...room, viewer: existing.viewer });
  for (const [key, data] of queryClient.getQueriesData<ListRoomsResponse>({ queryKey: roomKeys.lists })) {
    if (data === undefined) continue;
    const existing = data.items.find((item) => item.id === room.id);
    if (existing !== undefined) {
      queryClient.setQueryData<ListRoomsResponse>(key, { ...data, items: data.items.map((item) => (item.id === room.id ? keep(item) : item)) });
      continue;
    }
    const belongs =
      keyEquals(key, roomKeys.projectRooms(room.projectId)) ||
      (room.requirement !== null && keyEquals(key, roomKeys.requirementRooms(room.requirement.id)));
    if (belongs) queryClient.setQueryData<ListRoomsResponse>(key, { ...data, items: [...data.items, room] });
  }
  const detail = queryClient.getQueryData<RoomDto>(roomKeys.detail(room.id));
  if (detail !== undefined) queryClient.setQueryData<RoomDto>(roomKeys.detail(room.id), keep(detail));
}

function keyEquals(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/** 本地记已读后：列表与详情的未读清零（读到最新时）。 */
export function markReadLocally(queryClient: QueryClient, roomId: string, upToSeq: number): void {
  patchRoom(queryClient, roomId, (room) => roomAfterRead(room, upToSeq));
}

/** 记已读的回执就是记完后的「我的视角」：直接写回（只前进，回执比本地旧时不回退）。 */
export function applyViewer(queryClient: QueryClient, roomId: string, viewer: RoomViewerStateDto): void {
  patchRoom(queryClient, roomId, (room) =>
    viewer.lastReadSeq < room.viewer.lastReadSeq ? room : { ...room, viewer },
  );
}

// ---------- 消息 ----------

function mergeInto(queryClient: QueryClient, key: readonly unknown[], messages: readonly RoomMessageDto[]): void {
  const data = queryClient.getQueryData<MessagesData>(key);
  if (data === undefined) return;
  const merged = mergeMessages(data, messages).data;
  if (merged !== data) queryClient.setQueryData<MessagesData>(key, merged);
}

/**
 * 一条消息到了（实时事件或自己的发送回执）：主消息流、所在话题、以它为根的话题都合并；
 * 房间列表更新最后一条与未读（别人发的、我没在看的才算；同一条按 id 只算一次）。
 */
export function applyIncomingMessage(queryClient: QueryClient, message: RoomMessageDto): void {
  mergeInto(queryClient, roomKeys.messages(message.roomId), [message]);
  if (message.threadRootId !== null) mergeInto(queryClient, roomKeys.thread(message.roomId, message.threadRootId), [message]);
  mergeInto(queryClient, roomKeys.thread(message.roomId, message.id), [message]);
  if (!firstArrival(queryClient, message)) return;
  const meId = meIdOf(queryClient);
  patchRoom(queryClient, message.roomId, (room) => roomAfterMessage(room, message, { meId, reading: isReadingRoom(message.roomId) }));
}

/** 任务状态变了：写回触发消息下的状态行（主消息流与话题），运行详情重取。 */
export function applyRun(queryClient: QueryClient, run: AgentRunSummaryDto): void {
  const update = (key: readonly unknown[]) => {
    const data = queryClient.getQueryData<MessagesData>(key);
    if (data === undefined) return;
    const next = applyRunToMessages(data, run);
    if (next !== data) queryClient.setQueryData<MessagesData>(key, next);
  };
  update(roomKeys.messages(run.roomId));
  for (const [key] of queryClient.getQueriesData<MessagesData>({ queryKey: roomKeys.threads(run.roomId) })) update(key);
  void queryClient.invalidateQueries({ queryKey: roomKeys.run(run.id) });
  // 我的 Agent 在跑的任务、排队数在本机状态里。
  if (run.agent.owner.id === meIdOf(queryClient)) void queryClient.invalidateQueries({ queryKey: roomKeys.selfAgent });
}

// ---------- 共享与申请 ----------

export function upsertShare(queryClient: QueryClient, share: AgentShareDto): void {
  const key = roomKeys.shares(share.roomId);
  const data = queryClient.getQueryData<ListAgentSharesResponse>(key);
  if (data !== undefined) {
    const others = data.items.filter((item) => item.id !== share.id);
    queryClient.setQueryData<ListAgentSharesResponse>(key, { ...data, items: [...others, share] });
  }
}

export function upsertShareRequest(queryClient: QueryClient, request: AgentShareRequestDto): void {
  const key = roomKeys.shareRequests(request.roomId);
  const data = queryClient.getQueryData<ListAgentShareRequestsResponse>(key);
  if (data === undefined) return;
  const others = data.items.filter((item) => item.id !== request.id);
  queryClient.setQueryData<ListAgentShareRequestsResponse>(key, {
    ...data,
    // 列表只放待处理的；已开启 / 已忽略的移走。
    items: request.status === "pending" ? [...others, request] : others,
  });
}

// ---------- 在线 ----------

/** Agent 在线变化：Agent 列表、各房间共享里的 Agent、本机 Agent 状态。 */
export function patchAgent(queryClient: QueryClient, agent: AgentDto): void {
  const agents = queryClient.getQueryData<ListAgentsResponse>(roomKeys.agents);
  if (agents !== undefined) {
    const exists = agents.items.some((item) => item.id === agent.id);
    queryClient.setQueryData<ListAgentsResponse>(roomKeys.agents, {
      ...agents,
      items: exists ? agents.items.map((item) => (item.id === agent.id ? agent : item)) : [...agents.items, agent],
    });
  }
  for (const [key, data] of queryClient.getQueriesData<ListAgentSharesResponse>({ queryKey: roomKeys.all })) {
    if (!isSharesKey(key) || data === undefined || !data.items.some((share) => share.agent.id === agent.id)) continue;
    queryClient.setQueryData<ListAgentSharesResponse>(key, {
      ...data,
      items: data.items.map((share) => (share.agent.id === agent.id ? { ...share, agent } : share)),
    });
  }
  const self = queryClient.getQueryData<LocalAgentStateDto>(roomKeys.selfAgent);
  if (self?.agent?.id === agent.id) queryClient.setQueryData<LocalAgentStateDto>(roomKeys.selfAgent, { ...self, agent });
}

function isSharesKey(key: readonly unknown[]): boolean {
  return key[0] === "rooms" && key[1] === "room" && key[3] === "shares";
}

/** 真人在线变化：各房间成员列表。 */
export function patchUserPresence(queryClient: QueryClient, user: { id: string; online: boolean }): void {
  for (const [key, data] of queryClient.getQueriesData<ListRoomMembersResponse>({ queryKey: roomKeys.all })) {
    if (!(key[1] === "room" && key[3] === "members") || data === undefined) continue;
    if (!data.items.some((member) => member.user.id === user.id && member.online !== user.online)) continue;
    queryClient.setQueryData<ListRoomMembersResponse>(key, {
      ...data,
      items: data.items.map((member) => (member.user.id === user.id ? { ...member, online: user.online } : member)),
    });
  }
}
