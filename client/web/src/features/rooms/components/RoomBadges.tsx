import type { RoomDto } from "@suduo/cloud-contracts";
import { HashIcon, MessagesSquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { currentLocale } from "../../../i18n/locale.js";
import { messagesFor, type Messages } from "../../../i18n/messages/index.js";

/**
 * 房间的小标记（与房间列表同款）：类型图标（# 项目讨论 / 需求讨论）、未读数、@ 我。
 * 都是装饰：含义由所在按钮 / 选项的 aria-label 说清楚。
 */
export function RoomKindIcon({ room, className }: { room: Pick<RoomDto, "kind">; className?: string }) {
  const Icon = room.kind === "project_default" ? HashIcon : MessagesSquareIcon;
  return <Icon className={cn("size-3.5 shrink-0 text-subtle-foreground", className)} aria-hidden="true" />;
}

export function UnreadBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-caption leading-none font-semibold text-primary-foreground",
        className,
      )}
      aria-hidden="true"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function MentionBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-warning px-1 text-caption leading-none font-semibold text-background",
        className,
      )}
      aria-hidden="true"
    >
      @
    </span>
  );
}

/** 读屏用的一句话：名字（项目默认房间就是项目名，类型另说）、类型、未读、@。 */
export function roomAccessibleLabel(room: RoomDto, t: Messages = messagesFor(currentLocale())): string {
  const unread = Math.max(0, room.viewer.unreadCount);
  return [
    room.name,
    room.kind === "project_default" ? t.rooms.kind.project : t.rooms.kind.requirement,
    unread > 0 ? t.rooms.unread(unread) : null,
    room.viewer.mentionCount > 0 ? t.rooms.mentioned : null,
  ]
    .filter((part) => part !== null)
    .join(t.rooms.labelSeparator);
}
