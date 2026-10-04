import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ListRoomsResponse, RoomDto } from "@suduo/cloud-contracts";
import { ArchiveIcon, ChevronRightIcon, HashIcon, MessagesSquareIcon } from "lucide-react";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { classifyFailure } from "../../../feedback/classify.js";
import { RegionError } from "../../../feedback/components/index.js";
import { useT } from "../../../i18n/provider.js";
import { roomRequirementCode, roomTitle, sortRooms } from "../model.js";

/**
 * 房间列表（需求十一左栏）：项目默认房间在最上（「# 项目名」），需求房间带 REQ 编号；
 * 未读数与 @ 标记；归档的折叠在底部。
 */
export function RoomList({
  projectId,
  rooms,
  activeRoomId,
}: {
  projectId: string;
  rooms: UseQueryResult<ListRoomsResponse>;
  activeRoomId: string | null;
}) {
  const t = useT();
  const text = t.rooms.list;
  const [showArchived, setShowArchived] = useState(false);
  const sorted = sortRooms(rooms.data?.items ?? []);
  const activeArchived = sorted.archived.some((room) => room.id === activeRoomId);
  const archivedOpen = showArchived || activeArchived;
  return (
    <nav
      aria-label={text.label}
      className="flex h-full w-[248px] shrink-0 flex-col border-r border-border bg-background"
      data-testid="room-list"
    >
      <div className="flex h-[52px] shrink-0 items-center px-4">
        <h2 className="m-0 text-body font-semibold text-foreground">{text.title}</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {rooms.isPending ? (
          <div className="flex flex-col gap-2 p-2" aria-busy="true" aria-label={text.loading}>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-7 w-full" />
            ))}
          </div>
        ) : null}
        {rooms.isError && rooms.data === undefined ? (
          <RegionError
            kind={classifyFailure(rooms.error).kind}
            message={text.loadFailed(classifyFailure(rooms.error).message)}
            busy={rooms.isFetching}
            onRetry={() => void rooms.refetch()}
          />
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label={text.activeLabel}>
          {sorted.active.map((room) => (
            <RoomListItem key={room.id} projectId={projectId} room={room} active={room.id === activeRoomId} />
          ))}
        </ul>
        {sorted.archived.length === 0 ? null : (
          <div className="mt-3 flex flex-col gap-0.5">
            <button
              type="button"
              className="flex h-7 items-center gap-1.5 rounded-sm px-2 text-caption font-medium text-subtle-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={archivedOpen}
              onClick={() => setShowArchived((value) => !value)}
            >
              <ChevronRightIcon className={cn("size-3 transition-transform", archivedOpen && "rotate-90")} aria-hidden="true" />
              {text.archivedToggle(sorted.archived.length)}
            </button>
            {archivedOpen ? (
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label={text.archivedLabel}>
                {sorted.archived.map((room) => (
                  <RoomListItem key={room.id} projectId={projectId} room={room} active={room.id === activeRoomId} />
                ))}
              </ul>
            ) : null}
          </div>
        )}
        {rooms.isSuccess ? (
          <p className="m-0 mt-4 px-2 text-caption text-subtle-foreground">{text.requirementHint}</p>
        ) : null}
      </div>
    </nav>
  );
}

function RoomListItem({ projectId, room, active }: { projectId: string; room: RoomDto; active: boolean }) {
  const t = useT();
  const unread = Math.max(0, room.viewer.unreadCount);
  const mentions = Math.max(0, room.viewer.mentionCount);
  const rawCode = roomRequirementCode(room);
  const title = roomTitle(room);
  // 名字里已经带了编号（缺省名「REQ-1 讨论」）就不再单独显示编号。
  const code = rawCode !== null && title.startsWith(rawCode) ? null : rawCode;
  const label = [
    code === null ? title : `${code} ${title}`,
    room.archivedAt === null ? null : t.rooms.archivedState,
    unread > 0 ? t.rooms.unread(unread) : null,
    mentions > 0 ? t.rooms.mentioned : null,
  ]
    .filter((part) => part !== null)
    .join(t.rooms.labelSeparator);
  const Icon = room.archivedAt !== null ? ArchiveIcon : room.kind === "project_default" ? HashIcon : MessagesSquareIcon;
  return (
    <li>
      <Link
        to="/p/$projectId/rooms/$roomId"
        params={{ projectId, roomId: room.id }}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        data-testid="room-list-item"
        data-room-id={room.id}
        data-unread={unread}
        className={cn(
          "flex h-8 items-center gap-2 rounded-sm px-2 text-small no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "bg-muted-strong text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          unread > 0 && !active && "font-semibold text-foreground",
        )}
      >
        <Icon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
        {code === null ? null : <span className="shrink-0 font-mono text-caption text-subtle-foreground">{code}</span>}
        <span className="min-w-0 flex-1 truncate">{room.kind === "project_default" ? room.name : title}</span>
        {mentions > 0 ? (
          <span className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-warning px-1 text-caption leading-none font-semibold text-background" aria-hidden="true">
            @
          </span>
        ) : null}
        {unread > 0 ? (
          <span
            className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-primary px-1 text-caption leading-none font-semibold text-primary-foreground"
            aria-hidden="true"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </Link>
    </li>
  );
}
