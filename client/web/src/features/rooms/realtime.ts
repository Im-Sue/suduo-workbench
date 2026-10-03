import type { QueryClient } from "@tanstack/react-query";
import { ROOM_RESYNC_SSE_EVENT_NAME } from "@suduo/client-contracts";
import {
  ROOM_EVENT_TYPES,
  ROOM_SSE_EVENT_NAME,
  type RoomEventDto,
  type RoomEventType,
} from "@suduo/cloud-contracts";
import { api } from "../../api/client.js";
import { reportFailure } from "../../feedback/report.js";
import { showMessage } from "../../ui/message.js";
import {
  applyIncomingMessage,
  applyRun,
  findCachedRoom,
  meIdOf,
  patchAgent,
  patchUserPresence,
  upsertRoom,
  upsertShare,
  upsertShareRequest,
} from "./cache.js";
import { roomKeys } from "./keys.js";
import { endOfLocalDay } from "./model.js";

/**
 * 房间实时（技术设计 §4.3）：与需求事件共用外壳上的同一条 `/api/v2/events`，
 * 只多听两个命名事件——`room`（带内容，直接写缓存）与 `room-resync`（本机服务的上游连接断过：补拉）。
 * 浏览器自己的连接断线重连后同样补拉（requirements/realtime.tsx 的 onopen）。远程的 `ready` 帧（带 epoch）
 * 由本机 hub 自己消费、不转给浏览器，推送服务重启造成的缺口也由 hub 发 `room-resync` 通知。
 * 推送是广播：事件里房间的「我的视角」（未读）是中性值，写缓存时保留本地的，未读由前端自己算（cache.ts）。
 */

const KNOWN_TYPES = new Set<string>(ROOM_EVENT_TYPES);

export function parseRoomEvent(data: string): RoomEventDto | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const event = parsed as Partial<RoomEventDto>;
    if (typeof event.type !== "string" || !KNOWN_TYPES.has(event.type)) return null;
    return event as RoomEventDto;
  } catch {
    return null;
  }
}

export function applyRoomEvent(queryClient: QueryClient, event: RoomEventDto): void {
  const type: RoomEventType = event.type;
  switch (type) {
    case "room.changed":
      if (event.room !== undefined) upsertRoom(queryClient, event.room);
      else if (event.roomId !== null) void queryClient.invalidateQueries({ queryKey: roomKeys.detail(event.roomId) });
      // 新建 / 归档会改变列表本身（成员数、所属）：列表以服务端为准再取一次。
      void queryClient.invalidateQueries({ queryKey: roomKeys.lists });
      return;
    case "room.message":
      if (event.message !== undefined) applyIncomingMessage(queryClient, event.message);
      return;
    case "room.run":
      if (event.run !== undefined) applyRun(queryClient, event.run);
      return;
    case "room.members":
      if (event.roomId !== null) void queryClient.invalidateQueries({ queryKey: roomKeys.members(event.roomId) });
      void queryClient.invalidateQueries({ queryKey: roomKeys.lists });
      return;
    case "room.shares":
      if (event.share !== undefined) upsertShare(queryClient, event.share);
      else if (event.roomId !== null) void queryClient.invalidateQueries({ queryKey: roomKeys.shares(event.roomId) });
      // 我的 Agent 开着几个共享、在为谁执行：本机状态与 Agent 列表跟着刷新。
      void queryClient.invalidateQueries({ queryKey: roomKeys.agents });
      return;
    case "room.share_request":
      if (event.shareRequest !== undefined) {
        upsertShareRequest(queryClient, event.shareRequest);
        notifyShareRequest(queryClient, event.shareRequest);
      } else if (event.roomId !== null) {
        void queryClient.invalidateQueries({ queryKey: roomKeys.shareRequests(event.roomId) });
      }
      return;
    case "agent.presence":
      if (event.agent !== undefined) patchAgent(queryClient, event.agent);
      return;
    case "user.presence":
      if (event.user !== undefined) patchUserPresence(queryClient, event.user);
      return;
  }
}

/**
 * 断线补拉：
 * - 没人在看的房间消息 / 话题缓存直接丢掉：断线期间它们没收到事件，留着的话重连后的实时消息照样写进去，
 *   下次打开时增量补拉只从本地最大序号往后取，断线期间的那段就永远缺了。丢掉后下次打开整页重取。
 * - 其余房间相关查询整组失效：打开着的房间消息由查询函数按 `after=<本地最大序号>` 增量补齐
 *   （见 queries.ts 的 fetchMessages；补拉起点在失效时同步算好，之后到的实时消息不影响），列表、成员、共享、任务详情重取。
 */
export function resyncRooms(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: roomKeys.all, type: "inactive", predicate: (query) => isMessageCacheKey(query.queryKey) });
  void queryClient.invalidateQueries({ queryKey: roomKeys.all });
}

/** ["rooms", "room", roomId, "messages"] 与 ["rooms", "room", roomId, "thread", rootId]。 */
function isMessageCacheKey(key: readonly unknown[]): boolean {
  return key[1] === "room" && (key[3] === "messages" || key[3] === "thread");
}

/** 在需求实时的 EventSource 上挂房间的两个命名事件；返回解绑函数。 */
export function attachRoomListeners(source: EventSource, queryClient: QueryClient, isCurrent: () => boolean): () => void {
  // 只实现了 onmessage 的连接替身（各页面测试里的 EventSource 桩）：没有命名事件可听，跳过。
  if (typeof source.addEventListener !== "function") return () => undefined;
  const onRoom = (message: MessageEvent<string>) => {
    if (!isCurrent()) return;
    const event = parseRoomEvent(message.data);
    if (event !== null) applyRoomEvent(queryClient, event);
  };
  const onResync = () => {
    if (isCurrent()) resyncRooms(queryClient);
  };
  source.addEventListener(ROOM_SSE_EVENT_NAME, onRoom as EventListener);
  source.addEventListener(ROOM_RESYNC_SSE_EVENT_NAME, onResync);
  return () => {
    source.removeEventListener(ROOM_SSE_EVENT_NAME, onRoom as EventListener);
    source.removeEventListener(ROOM_RESYNC_SSE_EVENT_NAME, onResync);
  };
}

// ---------- 申请共享的提醒（所有者） ----------

const notified = new Set<string>();

function notifyShareRequest(queryClient: QueryClient, request: NonNullable<RoomEventDto["shareRequest"]>): void {
  const meId = meIdOf(queryClient);
  if (request.status !== "pending" || meId === null || request.agent.owner.id !== meId || request.requester.id === meId) return;
  if (notified.has(request.id)) return;
  notified.add(request.id);
  const room = findCachedRoom(queryClient, request.roomId);
  const where = room === undefined ? "一个讨论" : `「${room.name}」`;
  showMessage(`${request.requester.displayName} 想在${where}里使用你的 Codex（${request.agent.deviceName}）`, "info", {
    id: `share-request-${request.id}`,
    action: {
      label: "开启共享",
      onClick: () =>
        void api
          .resolveShareRequest(request.id, { action: "accept", duration: "today", expiresAt: endOfLocalDay() })
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: roomKeys.shareRequests(request.roomId) });
            void queryClient.invalidateQueries({ queryKey: roomKeys.shares(request.roomId) });
            void queryClient.invalidateQueries({ queryKey: roomKeys.agents });
            showMessage("已共享到今天结束", "success");
          })
          .catch((cause: unknown) => reportFailure(cause, { surface: "action", title: "没能开启共享" })),
    },
  });
}
