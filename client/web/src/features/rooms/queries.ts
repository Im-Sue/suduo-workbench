import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AgentRunSummaryDto, AgentShareDuration, RoomDto } from "@suduo/cloud-contracts";
import { useCallback, useState } from "react";
import { api } from "../../api/client.js";
import { reportFailure } from "../../feedback/report.js";
import { isRealtimeLive } from "../requirements/realtime-status.js";
import { applyRun, findCachedRoom, noteServerRooms, patchRoom, upsertRoom, upsertShare } from "./cache.js";
import { roomKeys } from "./keys.js";
import { catchUpAfter, endOfLocalDay, fromPage, mergeMessages, mergeOlderPage, mergeThreadRefetch, sortBySeq, type MessagesData } from "./model.js";

/**
 * 房间数据层（技术设计 §七）。查询键见 keys.ts；写缓存统一走 cache.ts。
 * 消息不走普通的「整页重取」：首次取最新一页，之后按序号增量补（实时事件、断线补拉、离线兜底轮询都一样）。
 */

export const MESSAGE_PAGE_SIZE = 50;
/** 话题一页的回复数（服务端单页上限）。 */
export const THREAD_PAGE_SIZE = 200;
const MAX_CATCH_UP_ROUNDS = 10;
/** 实时连接不在线时的兜底：按序号补拉的间隔。 */
const FALLBACK_POLL_MS = 15_000;

// ---------- 房间 ----------

export function projectRoomsQuery(projectId: string) {
  return queryOptions({
    queryKey: roomKeys.projectRooms(projectId),
    queryFn: async ({ signal, client }) => noteServerRooms(client, await api.listProjectRooms(projectId, { signal })),
    staleTime: 30_000,
  });
}

export function requirementRoomsQuery(requirementId: string) {
  return queryOptions({
    queryKey: roomKeys.requirementRooms(requirementId),
    queryFn: async ({ signal, client }) => noteServerRooms(client, await api.listRequirementRooms(requirementId, { signal })),
    staleTime: 30_000,
  });
}

/** 房间详情：列表里已有时先用列表里的（不闪骨架），后台再取一次。 */
export function useRoom(roomId: string | null) {
  const queryClient = useQueryClient();
  return useQuery<RoomDto>({
    queryKey: roomKeys.detail(roomId ?? ""),
    queryFn: ({ signal }) => api.getRoom(roomId ?? "", { signal }),
    enabled: roomId !== null,
    staleTime: 30_000,
    placeholderData: (): RoomDto | undefined => (roomId === null ? undefined : findCachedRoom(queryClient, roomId)),
  });
}

export function membersQuery(roomId: string) {
  return queryOptions({
    queryKey: roomKeys.members(roomId),
    queryFn: ({ signal }) => api.listRoomMembers(roomId, { signal }),
    staleTime: 60_000,
  });
}

// ---------- 消息 ----------

/**
 * 取消息：缓存里还没有 → 最新一页；已有 → 从本地最大序号往后补（`after`），多轮直到补齐。
 * 缺口太大（补了 10 轮还没完）就换成最新一页，不在中间留空洞；更早的照常向上翻。
 */
export async function fetchMessages(queryClient: QueryClient, roomId: string, signal?: AbortSignal): Promise<MessagesData> {
  const key = roomKeys.messages(roomId);
  const existing = queryClient.getQueryData<MessagesData>(key);
  const options = signal === undefined ? {} : { signal };
  if (existing === undefined) {
    return fromPage(await api.listRoomMessages(roomId, { limit: MESSAGE_PAGE_SIZE }, options));
  }
  let after = catchUpAfter(existing);
  let merged = existing;
  for (let round = 0; round < MAX_CATCH_UP_ROUNDS; round += 1) {
    const page = await api.listRoomMessages(roomId, { after, limit: MESSAGE_PAGE_SIZE }, options);
    const next = mergeMessages(merged, page.items).data;
    merged = { ...next, lastSeq: Math.max(next.lastSeq, page.lastSeq) };
    if (!page.hasMoreAfter || page.items.length === 0) return withLiveArrivals(queryClient, key, merged);
    after = Math.max(after, ...page.items.map((item) => item.seq));
  }
  return fromPage(await api.listRoomMessages(roomId, { limit: MESSAGE_PAGE_SIZE }, options));
}

/** 补拉期间实时事件写进缓存的消息：补拉结果里没有的也带上，免得被结果覆盖掉。 */
function withLiveArrivals(queryClient: QueryClient, key: readonly unknown[], merged: MessagesData): MessagesData {
  const latest = queryClient.getQueryData<MessagesData>(key);
  if (latest === undefined) return merged;
  const ids = new Set(merged.items.map((item) => item.id));
  const extra = latest.items.filter((item) => !ids.has(item.id));
  if (extra.length === 0) return merged;
  return { ...merged, items: sortBySeq([...merged.items, ...extra]), lastSeq: Math.max(merged.lastSeq, latest.lastSeq) };
}

export function messagesQuery(queryClient: QueryClient, roomId: string) {
  return queryOptions({
    queryKey: roomKeys.messages(roomId),
    queryFn: ({ signal }) => fetchMessages(queryClient, roomId, signal),
    // 实时事件直接写缓存；断线重连由补拉失效。实时不在线时才轮询补拉。
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchInterval: () => (isRealtimeLive() ? false : FALLBACK_POLL_MS),
    refetchIntervalInBackground: false,
    gcTime: 10 * 60_000,
  });
}

/** 主消息流的数据 + 向上翻历史。 */
export function useRoomMessages(roomId: string) {
  const queryClient = useQueryClient();
  const query = useQuery(messagesQuery(queryClient, roomId));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlder = useCallback(async () => {
    const key = roomKeys.messages(roomId);
    const data = queryClient.getQueryData<MessagesData>(key);
    if (data === undefined || !data.hasMoreBefore || loadingOlder) return;
    const before = data.items[0]?.seq;
    if (before === undefined) return;
    setLoadingOlder(true);
    try {
      const page = await api.listRoomMessages(roomId, { before, limit: MESSAGE_PAGE_SIZE });
      const base = queryClient.getQueryData<MessagesData>(key) ?? data;
      queryClient.setQueryData<MessagesData>(key, mergeOlderPage(base, page));
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: "没能加载更早的消息", retry: () => void loadOlder() });
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, queryClient, roomId]);
  return { ...query, loadOlder, loadingOlder };
}

/**
 * 话题：根 + 最新一页回复（更早的回复用 useThreadMessages 的 loadOlder 往前翻）。
 * 回复多于一页时根不在这一页里，单独取回放在最前面——话题面板始终有根消息可显示。
 */
export async function fetchThread(roomId: string, rootId: string, signal?: AbortSignal): Promise<MessagesData> {
  const options = signal === undefined ? {} : { signal };
  const data = fromPage(await api.listRoomMessages(roomId, { threadRootId: rootId, limit: THREAD_PAGE_SIZE }, options));
  if (!data.hasMoreBefore || data.items.some((item) => item.id === rootId)) return data;
  // 话题范围里序号最小的就是根：从头正序取一条。
  const head = await api.listRoomMessages(roomId, { threadRootId: rootId, after: 0, limit: 1 }, options);
  const root = head.items.find((item) => item.id === rootId);
  return root === undefined ? data : { ...data, items: sortBySeq([root, ...data.items]) };
}

export function threadQuery(roomId: string, rootId: string) {
  return queryOptions({
    queryKey: roomKeys.thread(roomId, rootId),
    queryFn: async ({ signal, client }): Promise<MessagesData> =>
      mergeThreadRefetch(
        client.getQueryData<MessagesData>(roomKeys.thread(roomId, rootId)),
        await fetchThread(roomId, rootId, signal),
        rootId,
      ),
    staleTime: 30_000,
    refetchInterval: () => (isRealtimeLive() ? false : FALLBACK_POLL_MS),
  });
}

/** 话题面板的数据 + 「加载更早的回复」（按最早一条回复的序号往前翻，做法同主消息流）。 */
export function useThreadMessages(roomId: string, rootId: string) {
  const queryClient = useQueryClient();
  const query = useQuery(threadQuery(roomId, rootId));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlder = useCallback(async () => {
    const key = roomKeys.thread(roomId, rootId);
    const data = queryClient.getQueryData<MessagesData>(key);
    if (data === undefined || !data.hasMoreBefore || loadingOlder) return;
    // 根可能是单独取来放在最前面的，不能拿它的序号翻页。
    const before = data.items.find((item) => item.id !== rootId)?.seq;
    if (before === undefined) return;
    setLoadingOlder(true);
    try {
      const page = await api.listRoomMessages(roomId, { threadRootId: rootId, before, limit: THREAD_PAGE_SIZE });
      const base = queryClient.getQueryData<MessagesData>(key) ?? data;
      queryClient.setQueryData<MessagesData>(key, mergeOlderPage(base, page));
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: "没能加载更早的回复", retry: () => void loadOlder() });
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, queryClient, roomId, rootId]);
  return { ...query, loadOlder, loadingOlder };
}

// ---------- Agent、共享、任务 ----------

export const agentsQuery = queryOptions({
  queryKey: roomKeys.agents,
  queryFn: ({ signal }) => api.listAgents({ signal }),
  staleTime: 30_000,
});

export const selfAgentQuery = queryOptions({
  queryKey: roomKeys.selfAgent,
  queryFn: ({ signal }) => api.getSelfAgent({ signal }),
  staleTime: 15_000,
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,
});

export function sharesQuery(roomId: string) {
  return queryOptions({
    queryKey: roomKeys.shares(roomId),
    queryFn: ({ signal }) => api.listRoomShares(roomId, { signal }),
    staleTime: 30_000,
  });
}

export function shareRequestsQuery(roomId: string) {
  return queryOptions({
    queryKey: roomKeys.shareRequests(roomId),
    queryFn: ({ signal }) => api.listShareRequests(roomId, { signal }),
    staleTime: 30_000,
  });
}

export function runQuery(runId: string) {
  return queryOptions({
    queryKey: roomKeys.run(runId),
    queryFn: ({ signal }) => api.getAgentRun(runId, { signal }),
    staleTime: 10_000,
  });
}

// ---------- 写操作 ----------

/** 改名 / 归档 / 取消归档：先改界面，失败回滚并提示。 */
export function useUpdateRoom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ room, patch }: { room: RoomDto; patch: { name?: string; archived?: boolean } }) => api.updateRoom(room.id, patch),
    onMutate: ({ room, patch }) => {
      patchRoom(queryClient, room.id, (current) => ({
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.archived === undefined ? {} : { archivedAt: patch.archived ? new Date().toISOString() : null }),
      }));
      return { before: room };
    },
    onSuccess: (saved) => upsertRoom(queryClient, saved),
    onError: (cause, { room }) => {
      patchRoom(queryClient, room.id, (current) => ({ ...current, name: room.name, archivedAt: room.archivedAt }));
      reportFailure(cause, { surface: "action", title: "没能保存房间" });
    },
  });
}

export function useJoinRoom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ roomId, userIds }: { roomId: string; userIds?: string[] }) =>
      api.addRoomMembers(roomId, userIds === undefined ? {} : { userIds }),
    onSettled: (_data, _error, { roomId }) => {
      void queryClient.invalidateQueries({ queryKey: roomKeys.members(roomId) });
      void queryClient.invalidateQueries({ queryKey: roomKeys.detail(roomId) });
      void queryClient.invalidateQueries({ queryKey: roomKeys.lists });
    },
    onError: (cause, { userIds }) => reportFailure(cause, { surface: "action", title: userIds === undefined ? "没能加入" : "没能添加成员" }),
  });
}

/** 开启共享（或改时长）。「今天」由浏览器给出本地当天结束时刻。 */
export function useOpenShare(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, duration }: { agentId: string; duration: AgentShareDuration }) =>
      api.openAgentShare(roomId, {
        agentId,
        duration,
        ...(duration === "today" ? { expiresAt: endOfLocalDay() } : {}),
      }),
    onSuccess: (share) => upsertShare(queryClient, share),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: roomKeys.shares(roomId) });
      void queryClient.invalidateQueries({ queryKey: roomKeys.agents });
    },
    onError: (cause) => reportFailure(cause, { surface: "action", title: "没能开启共享" }),
  });
}

export function useCloseShare(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) => api.closeAgentShare(shareId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: roomKeys.shares(roomId) });
      void queryClient.invalidateQueries({ queryKey: roomKeys.agents });
    },
    onError: (cause) => reportFailure(cause, { surface: "action", title: "没能关闭共享" }),
  });
}

export function useRequestShare(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.requestAgentShare(roomId, agentId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: roomKeys.shareRequests(roomId) }),
    onError: (cause) => reportFailure(cause, { surface: "action", title: "没能申请共享" }),
  });
}

export function useResolveShareRequest(roomId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, action, duration }: { requestId: string; action: "accept" | "ignore"; duration?: AgentShareDuration }) =>
      api.resolveShareRequest(requestId, {
        action,
        ...(action === "accept" && duration !== undefined
          ? { duration, ...(duration === "today" ? { expiresAt: endOfLocalDay() } : {}) }
          : {}),
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: roomKeys.shareRequests(roomId) });
      void queryClient.invalidateQueries({ queryKey: roomKeys.shares(roomId) });
      void queryClient.invalidateQueries({ queryKey: roomKeys.agents });
    },
    onError: (cause) => reportFailure(cause, { surface: "action", title: "没能处理申请" }),
  });
}

/** 停止 / 重试任务：回来的任务状态写回状态行。 */
export function useRunAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ run, action }: { run: AgentRunSummaryDto; action: "stop" | "retry" }) =>
      action === "stop" ? api.stopAgentRun(run.id) : api.retryAgentRun(run.id),
    onSuccess: (run) => {
      if (run !== undefined && run !== null && typeof run === "object" && "id" in run) applyRun(queryClient, run);
    },
    onError: (cause, { action }) => reportFailure(cause, { surface: "action", title: action === "stop" ? "没能停止" : "没能重试" }),
  });
}
