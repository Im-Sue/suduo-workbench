import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { RequirementsEventDto } from "@suduo/cloud-contracts";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../../api/client.js";
import { parseRequirementsEvent } from "../../components/requirements-v2/requirements-events.js";
import { queryKeys } from "../../app/queries.js";
import { ROOM_RESYNC_SSE_EVENT_NAME } from "@suduo/client-contracts";
import { attachRoomListeners, resyncRooms } from "../rooms/realtime.js";
import { markRemoteChange } from "./highlight.js";
import { requirementKeys } from "./keys.js";
import { invalidateProjectLists, refreshCardCounts } from "./queries.js";
import { setRealtimeLive } from "./realtime-status.js";

/**
 * 需求实时同步（技术设计 §6.4 / §9.2）：
 * - 外壳层只开一条 SSE；事件只带资源标识，这里据此精确失效对应查询，由 Query 重取最新数据；
 * - 断线重连成功后全量失效需求数据，补上断线期间的变化；连接出错时顺便确认登录态；
 * - 他人改动的需求在看板 / 列表上高亮约 2 秒（highlight.ts），不弹窗、不打断编辑。
 * - 房间事件走同一条连接的命名事件 `room` / `room-resync`（features/rooms/realtime.ts），不另开连接；
 *   重连成功后房间同样补拉（按房间序号增量补）。
 */
export type RealtimeState = "connecting" | "live" | "reconnecting";

const RealtimeContext = createContext<RealtimeState>("connecting");

export function useRequirementsRealtimeState(): RealtimeState {
  return useContext(RealtimeContext);
}

// ---------- 事件 → 查询失效 ----------

export function invalidateForEvent(queryClient: QueryClient, event: RequirementsEventDto): void {
  const item = event.requirementId === undefined ? null : requirementKeys.item(event.requirementId);
  switch (event.type) {
    case "project.changed":
      // 改名 / 归档：只影响项目本身和概览的动态，需求列表不用重取。
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      void queryClient.invalidateQueries({ queryKey: requirementKeys.overviewAudit(event.projectId) });
      return;
    case "requirement.changed":
      // 标题、状态、负责人可能变：看板 / 列表重取（排序和所在列都可能变），详情及其子资源整组重取。
      void invalidateProjectLists(queryClient, event.projectId);
      if (item !== null) void queryClient.invalidateQueries({ queryKey: item });
      if (event.requirementId !== undefined) markRemoteChange(event.requirementId);
      return;
    case "comment.created":
    case "attachment.changed":
    case "artifact.published":
      // 只影响这一条：重取它的详情和子资源，看板上那张卡的计数原地更新，不整板重拉（§6.4）。
      if (item !== null) void queryClient.invalidateQueries({ queryKey: item });
      if (event.requirementId !== undefined) void refreshCardCounts(queryClient, event.requirementId);
      // 概览的「最近动态」会显示评论、附件、产物，一起追加。
      void queryClient.invalidateQueries({ queryKey: requirementKeys.overviewAudit(event.projectId) });
      // 新评论：我的工作里的「有新评论」（指派给我的列表带新评论数）马上更新，不等 30 秒轮询。
      if (event.type === "comment.created") {
        void queryClient.invalidateQueries({ queryKey: [...requirementKeys.project(event.projectId), "assigned-to-me"] });
      }
      return;
  }
}

export function RequirementsRealtimeProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<RealtimeState>("connecting");
  useEffect(() => {
    setRealtimeLive(state === "live");
    return () => setRealtimeLive(false);
  }, [state]);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return undefined;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let delay = 1_000;
    let openedOnce = false;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const next = new EventSource(api.requirementsEventsUrl());
      source = next;
      attachRoomListeners(next, queryClient, () => !stopped && source === next);
      // 本机服务的上游连接断过又连上（room-resync）：需求事件不补发，浏览器这条连接却一直开着，
      // 所以这里也要把需求数据整体刷新一次，补上断线期间的变化。
      if (typeof next.addEventListener === "function") {
        next.addEventListener(ROOM_RESYNC_SSE_EVENT_NAME, () => {
          if (!stopped && source === next) void queryClient.invalidateQueries({ queryKey: requirementKeys.all });
        });
      }
      next.onopen = () => {
        if (stopped || source !== next) return;
        delay = 1_000;
        setState("live");
        if (openedOnce) {
          void queryClient.invalidateQueries({ queryKey: requirementKeys.all });
          resyncRooms(queryClient);
        }
        openedOnce = true;
      };
      next.onerror = () => {
        if (stopped || source !== next) return;
        next.close();
        setState("reconnecting");
        // 断线可能是登录过期：刷新设置，由根路由决定是否回到登录页。
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
        if (reconnectTimer === null) {
          const wait = delay;
          delay = Math.min(delay * 2, 10_000);
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, wait);
        }
      };
      next.onmessage = (message: MessageEvent<string>) => {
        if (stopped || source !== next) return;
        const event = parseRequirementsEvent(message.data);
        if (event !== null) invalidateForEvent(queryClient, event);
      };
    };

    setState("connecting");
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [enabled, queryClient]);

  return <RealtimeContext.Provider value={state}>{children}</RealtimeContext.Provider>;
}
