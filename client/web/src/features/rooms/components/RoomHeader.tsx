import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { RoomDto } from "@suduo/cloud-contracts";
import { ArchiveIcon, ArchiveRestoreIcon, MoreHorizontalIcon, PencilIcon, UserPlusIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { classifyFailure } from "../../../feedback/classify.js";
import { FormDialog, InlineError } from "../../../feedback/components/index.js";
import { useT } from "../../../i18n/provider.js";
import { showMessage } from "../../../ui/message.js";
import { UserAvatar } from "../../requirements/components/UserAvatar.js";
import { usersQuery } from "../../requirements/queries.js";
import { roomRequirementCode, roomTitle } from "../model.js";
import { membersQuery, useJoinRoom, useUpdateRoom } from "../queries.js";
import { ShareAgentButton } from "./ShareAgentPanel.js";

/**
 * 房间头部（需求十一）：房间名、所属（项目 / 需求链接）、成员头像叠放 + 在线点、「共享 Agent」、更多（改名、归档 / 取消归档）。
 * 归档可逆：不弹确认，给「撤销」。项目默认房间名称跟随项目，不能改名。
 */
export function RoomHeader({ room, meId }: { room: RoomDto; meId: string | null }) {
  const t = useT();
  const update = useUpdateRoom();
  const join = useJoinRoom();
  const [renaming, setRenaming] = useState(false);
  const code = roomRequirementCode(room);
  const archived = room.archivedAt !== null;

  const setArchived = (next: boolean) => {
    update.mutate(
      { room, patch: { archived: next } },
      {
        onSuccess: () =>
          showMessage(next ? t.rooms.header.archivedToast(room.name) : t.rooms.header.unarchivedToast(room.name), "success", {
            action: { label: t.rooms.header.undo, onClick: () => update.mutate({ room: { ...room, archivedAt: next ? new Date().toISOString() : null }, patch: { archived: !next } }) },
          }),
      },
    );
  };

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border pr-3 pl-5" data-testid="room-header">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="m-0 truncate text-body font-semibold text-foreground">{roomTitle(room)}</h1>
        {archived ? <Badge>{t.rooms.archived}</Badge> : null}
        <span className="hidden min-w-0 items-center gap-1 truncate text-caption text-subtle-foreground md:flex">
          {room.requirement === null ? (
            t.rooms.header.projectScope
          ) : (
            <>
              {t.rooms.header.requirementPrefix}
              <Link
                to="/p/$projectId/requirements/$number"
                params={{ projectId: room.projectId, number: String(room.requirement.number) }}
                className="truncate text-primary-text no-underline hover:underline"
              >
                {code} {room.requirement.title}
              </Link>
            </>
          )}
        </span>
      </div>
      <MembersButton room={room} />
      {!room.viewer.joined && room.kind === "requirement" ? (
        <Button size="sm" variant="secondary" loading={join.isPending} onClick={() => join.mutate({ roomId: room.id })}>
          {t.rooms.header.join}
        </Button>
      ) : null}
      <ShareAgentButton room={room} meId={meId} />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={t.rooms.header.moreActions}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {room.kind === "requirement" ? (
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <PencilIcon />
              {t.rooms.header.rename}
            </DropdownMenuItem>
          ) : null}
          {archived ? (
            <DropdownMenuItem onSelect={() => setArchived(false)}>
              <ArchiveRestoreIcon />
              {t.rooms.header.unarchive}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => setArchived(true)}>
              <ArchiveIcon />
              {t.rooms.header.archive}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog
        room={room}
        open={renaming}
        onOpenChange={setRenaming}
        onSave={(name) => update.mutate({ room, patch: { name } })}
      />
    </header>
  );
}

function RenameDialog({
  room,
  open,
  onOpenChange,
  onSave,
}: {
  room: RoomDto;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSave(name: string): void;
}) {
  const t = useT();
  const [name, setName] = useState(room.name);
  const [error, setError] = useState(false);
  const trimmed = name.trim();
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (next) setName(room.name);
        setError(false);
        onOpenChange(next);
      }}
      title={t.rooms.rename.title}
      hasUnsavedChanges={trimmed !== room.name && trimmed !== ""}
      size="sm"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === "") {
            setError(true);
            return;
          }
          if (trimmed !== room.name) onSave(trimmed);
          onOpenChange(false);
        }}
      >
        <label htmlFor={`room-name-${room.id}`} className="text-small font-medium">{t.rooms.rename.nameLabel}</label>
        <Input
          id={`room-name-${room.id}`}
          autoFocus
          maxLength={80}
          value={name}
          aria-invalid={error || undefined}
          onChange={(event) => setName(event.target.value)}
        />
        {error ? <InlineError kind="validation">{t.rooms.rename.nameRequired}</InlineError> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t.rooms.rename.cancel}</Button>
          <Button type="submit" variant="primary">{t.rooms.rename.save}</Button>
        </div>
      </form>
    </FormDialog>
  );
}

/** 成员头像叠放 + 人数；点开看成员与在线、拉人。讨论页头部与悬浮窗口标题栏共用。 */
export function MembersButton({ room }: { room: RoomDto }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const members = useQuery(membersQuery(room.id));
  const items = members.data?.items ?? [];
  const online = items.filter((member) => member.online).length;
  const shown = items.toSorted((left, right) => Number(right.online) - Number(left.online)).slice(0, 4);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-sm px-1.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t.rooms.members.buttonLabel(room.memberCount, members.isSuccess ? online : null)}
          data-testid="room-members-button"
        >
          <span className="flex -space-x-1.5" aria-hidden="true">
            {shown.map((member) => (
              <span key={member.user.id} className="relative">
                <UserAvatar user={member.user} size="lg" className="ring-2 ring-card" />
                {member.online ? <span className="absolute right-0 bottom-0 size-2 rounded-full bg-success ring-2 ring-card" /> : null}
              </span>
            ))}
          </span>
          <span className="text-caption text-muted-foreground">{room.memberCount}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="flex flex-col">
          <div className="border-b border-border px-3 py-2 text-small font-semibold">
            {t.rooms.members.heading(room.memberCount)}
            {members.isSuccess ? <span className="ml-1.5 font-normal text-subtle-foreground">{t.rooms.members.onlineCount(online)}</span> : null}
          </div>
          {members.isPending ? <Skeleton className="m-3 h-8" /> : null}
          {members.isError ? (
            <p className="m-0 px-3 py-2 text-caption text-danger" role="alert">{t.rooms.members.loadFailed(classifyFailure(members.error).message)}</p>
          ) : null}
          <ul className="m-0 flex max-h-64 list-none flex-col overflow-y-auto p-1" aria-label={t.rooms.members.listLabel}>
            {items.map((member) => (
              <li key={member.user.id} className="flex h-8 items-center gap-2 rounded-sm px-2 text-small">
                <UserAvatar user={member.user} />
                <span className="min-w-0 flex-1 truncate">{member.user.displayName}</span>
                <span className={cn("text-caption", member.online ? "text-success" : "text-subtle-foreground")}>
                  {member.online ? t.rooms.members.online : t.rooms.members.offline}
                </span>
              </li>
            ))}
          </ul>
          {room.kind === "requirement" && room.archivedAt === null ? (
            <AddMembers roomId={room.id} memberIds={new Set(items.map((member) => member.user.id))} />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AddMembers({ roomId, memberIds }: { roomId: string; memberIds: ReadonlySet<string> }) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const users = useQuery({ ...usersQuery, enabled: adding });
  const join = useJoinRoom();
  if (!adding) {
    return (
      <div className="border-t border-border p-1">
        <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => setAdding(true)}>
          <UserPlusIcon />
          {t.rooms.members.add}
        </Button>
      </div>
    );
  }
  const candidates = (users.data?.items ?? []).filter((user) => !memberIds.has(user.id));
  return (
    <div className="border-t border-border">
      <Command>
        <CommandInput placeholder={t.rooms.members.searchPlaceholder} />
        <CommandList className="max-h-48">
          {users.isPending ? <div className="px-3 py-2 text-small text-subtle-foreground">{t.rooms.members.loading}</div> : null}
          {users.isError ? <div className="px-3 py-2 text-small text-danger">{t.rooms.usersLoadFailed(classifyFailure(users.error).message)}</div> : null}
          <CommandEmpty>{t.rooms.members.noneToAdd}</CommandEmpty>
          <CommandGroup>
            {candidates.map((user) => (
              <CommandItem
                key={user.id}
                value={`${user.displayName} ${user.id}`}
                onSelect={() => join.mutate({ roomId, userIds: [user.id] }, { onSuccess: () => showMessage(t.rooms.members.added(user.displayName), "success") })}
              >
                <UserAvatar user={user} />
                {user.displayName}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
