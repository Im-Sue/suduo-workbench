import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { RequirementListItemDto } from "@suduo/client-contracts";
import type { RoomDto, UserSummaryDto } from "@suduo/cloud-contracts";
import { ArchiveIcon, MessagesSquareIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "../../../api/client.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { EmptyState, FormDialog, InlineError, RegionError } from "../../../feedback/components/index.js";
import type { Failure } from "../../../feedback/types.js";
import { useT } from "../../../i18n/provider.js";
import { UserAvatar } from "../../requirements/components/UserAvatar.js";
import { requirementCode } from "../../requirements/format.js";
import { usersQuery } from "../../requirements/queries.js";
import { upsertRoom } from "../cache.js";
import { roomKeys } from "../keys.js";
import { sortRooms } from "../model.js";
import { requirementRoomsQuery } from "../queries.js";
import { formatDateTime, formatRelativeTime } from "../../../ui/format.js";

/**
 * 需求详情的「讨论」区块（需求 4.1）：本需求的房间（未读、最后一条）+「新建讨论」。
 * 新建：名字缺省「REQ-n 讨论」，可选拉人；创建人、需求负责人、需求创建人总是在内。
 */
export function RequirementRooms({ requirement, me }: { requirement: RequirementListItemDto; me: UserSummaryDto | null }) {
  const t = useT();
  const text = t.rooms.requirementRooms;
  const rooms = useQuery(requirementRoomsQuery(requirement.id));
  const [creating, setCreating] = useState(false);
  const sorted = sortRooms(rooms.data?.items ?? []);
  const all = [...sorted.active, ...sorted.archived];
  return (
    <section aria-labelledby={`rooms-heading-${requirement.id}`} className="flex flex-col gap-3" data-testid="requirement-rooms">
      <div className="flex items-center gap-2">
        <h2 id={`rooms-heading-${requirement.id}`} className="m-0 text-section font-semibold">{text.title}</h2>
        {all.length > 0 ? <span className="text-caption text-subtle-foreground">{all.length}</span> : null}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setCreating(true)} data-testid="new-requirement-room">
          <PlusIcon />
          {text.create}
        </Button>
      </div>
      {rooms.isPending ? <Skeleton className="h-10 w-full" /> : null}
      {rooms.isError && rooms.data === undefined ? (
        <RegionError
          kind={classifyFailure(rooms.error).kind}
          message={text.loadFailed(classifyFailure(rooms.error).message)}
          busy={rooms.isFetching}
          onRetry={() => void rooms.refetch()}
        />
      ) : null}
      {rooms.isSuccess && all.length === 0 ? (
        <EmptyState
          size="inline"
          title={text.empty}
          action={{ label: text.create, onClick: () => setCreating(true) }}
        />
      ) : null}
      {all.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {all.map((room) => {
            const unread = Math.max(0, room.viewer.unreadCount);
            return (
              <li key={room.id}>
                <Link
                  to="/p/$projectId/rooms/$roomId"
                  params={{ projectId: room.projectId, roomId: room.id }}
                  className="flex min-h-10 items-center gap-2.5 rounded-sm bg-muted px-2.5 py-1.5 text-small text-foreground no-underline outline-none hover:bg-muted-strong focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="requirement-room-link"
                  data-room-id={room.id}
                  aria-label={text.linkLabel(room.name, room.archivedAt !== null, unread)}
                >
                  {room.archivedAt === null ? (
                    <MessagesSquareIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
                  ) : (
                    <ArchiveIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{room.name}</span>
                    {room.lastMessage === null ? null : (
                      <span className="truncate text-caption text-subtle-foreground">
                        {text.lastMessage(room.lastMessage.authorName, room.lastMessage.preview)}
                      </span>
                    )}
                  </span>
                  {room.lastMessage === null ? null : (
                    <time className="shrink-0 text-caption text-subtle-foreground" title={formatDateTime(room.lastMessage.createdAt)}>
                      {formatRelativeTime(room.lastMessage.createdAt)}
                    </time>
                  )}
                  {unread > 0 ? (
                    <span className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-primary px-1 text-caption leading-none font-semibold text-primary-foreground" aria-hidden="true">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <CreateRoomDialog key={requirement.id} requirement={requirement} me={me} open={creating} onOpenChange={setCreating} />
    </section>
  );
}

/**
 * 新建需求讨论的对话框。建好后默认进房间整页；给了 onCreated 就交给调用方（需求预览面板：在悬浮窗口里打开）。
 */
export function CreateRoomDialog({
  requirement,
  me,
  open,
  onOpenChange,
  onCreated,
}: {
  requirement: RequirementListItemDto;
  me: UserSummaryDto | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated?: (room: RoomDto) => void;
}) {
  const t = useT();
  const text = t.rooms.createDialog;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const defaultName = text.defaultName(requirementCode(requirement.number));
  const [name, setName] = useState(defaultName);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const users = useQuery({ ...usersQuery, enabled: open });
  // 总在里面的人：创建人（我）、需求负责人、需求创建人。
  const always = new Set([me?.id, requirement.assignee?.id, requirement.createdBy.id].filter((id): id is string => id !== undefined));
  const others = (users.data?.items ?? []).filter((user) => !always.has(user.id));

  const reset = () => {
    setName(defaultName);
    setMemberIds([]);
    setError(null);
  };

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const room = await api.createRequirementRoom(requirement.id, {
        name: name.trim() === "" ? defaultName : name.trim(),
        ...(memberIds.length === 0 ? {} : { memberIds }),
      });
      upsertRoom(queryClient, room);
      void queryClient.invalidateQueries({ queryKey: roomKeys.requirementRooms(requirement.id) });
      void queryClient.invalidateQueries({ queryKey: roomKeys.projectRooms(room.projectId) });
      onOpenChange(false);
      reset();
      if (onCreated !== undefined) onCreated(room);
      else void navigate({ to: "/p/$projectId/rooms/$roomId", params: { projectId: room.projectId, roomId: room.id } });
    } catch (cause) {
      setError(classifyFailure(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={text.title}
      description={text.description(requirementCode(requirement.number))}
      hasUnsavedChanges={name.trim() !== defaultName || memberIds.length > 0}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`new-room-name-${requirement.id}`} className="text-small font-medium">{text.nameLabel}</label>
          <Input
            id={`new-room-name-${requirement.id}`}
            autoFocus
            maxLength={80}
            value={name}
            placeholder={defaultName}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1.5 p-0 text-small font-medium">{text.membersLegend}</legend>
          {users.isPending ? <Skeleton className="h-8 w-full" /> : null}
          {users.isError ? (
            <p className="m-0 text-caption text-danger" role="alert">{t.rooms.usersLoadFailed(classifyFailure(users.error).message)}</p>
          ) : null}
          {users.isSuccess && others.length === 0 ? (
            <p className="m-0 text-caption text-subtle-foreground">{text.noOthers}</p>
          ) : null}
          <ul className="m-0 flex max-h-48 list-none flex-col gap-0.5 overflow-y-auto p-0">
            {others.map((user) => {
              const id = `new-room-member-${requirement.id}-${user.id}`;
              const checked = memberIds.includes(user.id);
              return (
                <li key={user.id} className="flex h-8 items-center gap-2 rounded-sm px-1.5 hover:bg-muted">
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={(value) =>
                      setMemberIds((current) => (value === true ? [...current, user.id] : current.filter((item) => item !== user.id)))
                    }
                  />
                  <label htmlFor={id} className="flex flex-1 cursor-pointer items-center gap-2 text-small">
                    <UserAvatar user={user} />
                    {user.displayName}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        {error === null ? null : <InlineError kind={error.kind}>{text.failed(error.message)}</InlineError>}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            {text.cancel}
          </Button>
          <Button type="submit" variant="primary" loading={saving} data-testid="create-requirement-room">
            {text.submit}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}
