import { useQuery } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import type { RoomDto } from "@suduo/cloud-contracts";
import { useCallback, useEffect, useMemo } from "react";
import { settingsQuery } from "../../app/queries.js";
import { classifyFailure } from "../../feedback/classify.js";
import { EmptyState, RegionError } from "../../feedback/components/index.js";
import { RoomBody, RoomSkeleton } from "./components/RoomBody.js";
import { RoomHeader } from "./components/RoomHeader.js";
import { RoomList } from "./components/RoomList.js";
import { panelFromSearch, searchFromPanel, type RoomPanelState } from "./panel.js";
import { projectRoomsQuery, useRoom } from "./queries.js";

/**
 * 讨论页（需求十一）：房间列表 ｜ 消息流 ｜ 右侧话题面板。
 * 话题与运行详情写在 URL 里（`?thread=<根消息>&run=<任务>`），可分享、可回退；不带房间时进项目默认房间。
 * 对话区（RoomBody）与悬浮窗口共用；这里只负责把 URL 里的面板参数交给它、把它的改动写回 URL。
 */
export interface RoomsSearch {
  thread?: string;
  run?: string;
}

export function validateRoomsSearch(search: Record<string, unknown>): RoomsSearch {
  const thread = typeof search["thread"] === "string" && search["thread"] !== "" ? search["thread"] : undefined;
  const run = thread !== undefined && typeof search["run"] === "string" && search["run"] !== "" ? search["run"] : undefined;
  return { ...(thread === undefined ? {} : { thread }), ...(run === undefined ? {} : { run }) };
}

export function RoomsPage({ projectId, roomId, search }: { projectId: string; roomId: string | null; search: RoomsSearch }) {
  const rooms = useQuery(projectRoomsQuery(projectId));

  if (roomId === null) {
    const fallback = rooms.data?.items.find((room) => room.kind === "project_default") ?? rooms.data?.items.find((room) => room.archivedAt === null);
    if (fallback !== undefined) {
      return <Navigate to="/p/$projectId/rooms/$roomId" params={{ projectId, roomId: fallback.id }} replace />;
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="rooms-page">
      <RoomList projectId={projectId} rooms={rooms} activeRoomId={roomId} />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="讨论区">
        {roomId !== null ? (
          <RoomView key={roomId} projectId={projectId} roomId={roomId} search={search} />
        ) : rooms.isSuccess ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              size="page"
              title="这个项目还没有讨论"
              description="项目讨论会在第一次打开时自动建立；需求下的讨论在需求详情里新建。"
            />
          </div>
        ) : rooms.isError ? (
          <div className="flex flex-1 items-center justify-center">
            <RegionError
              kind={classifyFailure(rooms.error).kind}
              message={`查不到讨论：${classifyFailure(rooms.error).message}`}
              busy={rooms.isFetching}
              onRetry={() => void rooms.refetch()}
            />
          </div>
        ) : (
          <RoomSkeleton />
        )}
      </section>
    </div>
  );
}

function RoomView({ projectId, roomId, search }: { projectId: string; roomId: string; search: RoomsSearch }) {
  const navigate = useNavigate();
  const room = useRoom(roomId);
  const data = room.data;

  // 房间属于别的项目（跨项目链接）：换成规范地址。
  useEffect(() => {
    if (data !== undefined && data.projectId !== projectId) {
      void navigate({ to: "/p/$projectId/rooms/$roomId", params: { projectId: data.projectId, roomId }, search, replace: true });
    }
  }, [data, navigate, projectId, roomId, search]);

  if (data === undefined) {
    if (room.isError) {
      const failure = classifyFailure(room.error);
      return (
        <div className="flex flex-1 items-center justify-center">
          <RegionError
            kind={failure.kind}
            message={failure.status === 404 ? "查不到这个讨论：它可能已被移走，或链接有误。" : `查不到这个讨论：${failure.message}`}
            busy={room.isFetching}
            onRetry={() => void room.refetch()}
          />
        </div>
      );
    }
    return <RoomSkeleton />;
  }
  return <RoomPage projectId={projectId} room={data} search={search} />;
}

function RoomPage({ projectId, room, search }: { projectId: string; room: RoomDto; search: RoomsSearch }) {
  const navigate = useNavigate();
  const meId = useQuery(settingsQuery).data?.session?.user.id ?? null;
  const panel = useMemo(() => panelFromSearch(search), [search]);
  const onPanelChange = useCallback(
    (next: RoomPanelState) =>
      void navigate({ to: "/p/$projectId/rooms/$roomId", params: { projectId, roomId: room.id }, search: searchFromPanel(next) }),
    [navigate, projectId, room.id],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="room-view" data-room-id={room.id}>
      <RoomHeader room={room} meId={meId} />
      <RoomBody room={room} panel={panel} onPanelChange={onPanelChange} />
    </div>
  );
}
