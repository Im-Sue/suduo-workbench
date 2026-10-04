import { useQuery } from "@tanstack/react-query";
import type { RequirementListItemDto } from "@suduo/client-contracts";
import type { UserSummaryDto } from "@suduo/cloud-contracts";
import { ChevronDownIcon, MessageSquarePlusIcon, MessagesSquareIcon, PlusIcon, RotateCwIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { settingsQuery } from "../../../app/queries.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { useT } from "../../../i18n/provider.js";
import { MentionBadge, RoomKindIcon, roomAccessibleLabel, UnreadBadge } from "../components/RoomBadges.js";
import { hasUnreadMention, quickAccessRooms, totalUnread } from "../model.js";
import { requirementRoomsQuery } from "../queries.js";
import { useRoomWindow } from "../window/store.js";
import { CreateRoomDialog } from "./RequirementRooms.js";

/**
 * 需求预览面板底部的讨论按钮（快捷入口需求 R5），按这条需求未归档的房间数：
 * - 0 个：「创建讨论」→ 新建对话框（名字缺省「REQ-n 讨论」，可选拉人）→ 建好直接在悬浮窗口打开；
 * - 1 个：「进入讨论」，有未读带数字；
 * - 多个：「进入讨论 ▾」下拉，列出各房间（未读、@）+「新建讨论」。
 * 已归档的不列（需求完整页的「讨论」区块照常能看到）。打开一律走 useRoomWindow().open，窄屏直接进讨论页。
 */
export function RequirementRoomButton({ requirement }: { requirement: RequirementListItemDto }) {
  const t = useT();
  const text = t.rooms.roomButton;
  const rooms = useQuery(requirementRoomsQuery(requirement.id));
  const user = useQuery(settingsQuery).data?.session?.user ?? null;
  const me = useMemo<UserSummaryDto | null>(() => (user === null ? null : { id: user.id, displayName: user.displayName }), [user]);
  const roomWindow = useRoomWindow();
  const [creating, setCreating] = useState(false);
  const active = useMemo(() => quickAccessRooms(rooms.data?.items ?? []), [rooms.data]);
  const unread = totalUnread(active);
  const mentioned = hasUnreadMention(active);

  const dialog = (
    <CreateRoomDialog
      requirement={requirement}
      me={me}
      open={creating}
      onOpenChange={setCreating}
      onCreated={(room) => roomWindow.open(room.projectId, room.id)}
    />
  );

  if (rooms.data === undefined) {
    if (rooms.isError) {
      const reason = text.loadFailed(classifyFailure(rooms.error).message);
      return (
        <Button
          variant="secondary"
          title={reason}
          aria-label={reason}
          loading={rooms.isFetching}
          onClick={() => void rooms.refetch()}
          data-testid="requirement-peek-room-button"
          data-mode="error"
        >
          <RotateCwIcon />
          {text.retry}
        </Button>
      );
    }
    return (
      <Button variant="secondary" loading disabled data-testid="requirement-peek-room-button" data-mode="loading">
        {text.enter}
      </Button>
    );
  }

  const [first] = active;
  if (first === undefined) {
    return (
      <>
        <Button variant="secondary" onClick={() => setCreating(true)} data-testid="requirement-peek-room-button" data-mode="create">
          <MessageSquarePlusIcon />
          {text.create}
        </Button>
        {dialog}
      </>
    );
  }

  if (active.length === 1) {
    return (
      <>
        <Button
          variant="secondary"
          aria-label={text.enterLabel(roomAccessibleLabel(first, t))}
          onClick={() => roomWindow.open(first.projectId, first.id)}
          data-testid="requirement-peek-room-button"
          data-mode="enter"
          data-room-id={first.id}
        >
          <MessagesSquareIcon />
          {text.enter}
          {first.viewer.mentionCount > 0 ? <MentionBadge /> : null}
          <UnreadBadge count={first.viewer.unreadCount} />
        </Button>
        {dialog}
      </>
    );
  }

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            aria-label={text.menuLabel(active.length, unread, mentioned)}
            data-testid="requirement-peek-room-button"
            data-mode="menu"
          >
            <MessagesSquareIcon />
            {text.enter}
            {mentioned ? <MentionBadge /> : null}
            <UnreadBadge count={unread} />
            <ChevronDownIcon className="size-3.5! text-subtle-foreground" />
          </Button>
        </DropdownMenuTrigger>
        {/* 选了房间后焦点交给悬浮窗口的输入框，不还给按钮：否则接着打字会被看板的单键快捷键拿走。 */}
        <DropdownMenuContent align="end" className="w-64" onCloseAutoFocus={(event) => event.preventDefault()}>
          {active.map((room) => (
            <DropdownMenuItem
              key={room.id}
              aria-label={roomAccessibleLabel(room, t)}
              onSelect={() => roomWindow.open(room.projectId, room.id)}
              data-testid="requirement-peek-room-item"
              data-room-id={room.id}
            >
              <RoomKindIcon room={room} />
              <span className="min-w-0 flex-1 truncate">{room.name}</span>
              {room.viewer.mentionCount > 0 ? <MentionBadge /> : null}
              <UnreadBadge count={room.viewer.unreadCount} />
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)} data-testid="requirement-peek-new-room">
            <PlusIcon />
            {text.newRoom}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}
