import type { SessionListItemDto } from "@suduo/client-contracts";
import { formatRequirementNumber } from "@suduo/cloud-contracts";
import { ArchiveIcon, HashIcon, MessageCircleIcon, MessagesSquareIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useLossCheck, useT } from "../../i18n/provider.js";
import { formatRelativeTime } from "../../ui/format.js";
import type { SessionLiveRunState } from "../../ui/session-status.js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { SessionStatusDot } from "./SessionStatusDot.js";
import {
  groupByDay,
  lastActivity,
  matchesFilter,
  matchesSearch,
  rowStatus,
  type SessionFilter,
} from "./session-list.js";

/**
 * 会话列表栏（需求 §4.5，只列当前项目）：新建、搜索、筛选（全部 / 运行中 / 需要我 / 房间任务）、按天分组；
 * 每行：状态、标题、关联需求编号、最后活动时间、最后一句；「…」里重命名（原地）、归档、删除。
 * 房间任务行（共享 Agent 在本机执行的会话）：标题是话题，标签是房间名；「…」里可回到讨论里的那个话题。
 * 搜索词与筛选是列表栏自己的状态：切换会话时不丢。
 */
export function SessionList({
  items,
  loading,
  error,
  hasMore,
  loadingMore,
  activeSessionId,
  live,
  filter,
  keyword,
  canCreate,
  createDisabledReason,
  onFilterChange,
  onKeywordChange,
  onLoadMore,
  onOpen,
  onCreate,
  onRename,
  onArchive,
  onDelete,
  countItems,
  onOpenRoom,
  projectName = (item) => item.project.name,
}: {
  items: SessionListItemDto[];
  /**
   * 没有最后一句时行里显示的项目名；缺省用本机项目名。一个目录可以关联多个项目，
   * 本机项目名只是第一个关联它的项目的名字，会话页传入按所属项目取的远程项目名。
   */
  projectName?(item: SessionListItemDto): string;
  /** 「运行中 / 需要我」计数用的列表（房间任务筛选下显示的是另一份列表）；缺省同 items。 */
  countItems?: SessionListItemDto[];
  /** 房间任务：回到讨论里对应的话题。 */
  onOpenRoom?(item: SessionListItemDto): void;
  loading: boolean;
  error: ReactNode | null;
  hasMore: boolean;
  loadingMore: boolean;
  activeSessionId: string | null;
  live: SessionLiveRunState | null;
  filter: SessionFilter;
  keyword: string;
  canCreate: boolean;
  createDisabledReason: string;
  onFilterChange(filter: SessionFilter): void;
  onKeywordChange(keyword: string): void;
  onLoadMore(): void;
  onOpen(item: SessionListItemDto): void;
  onCreate(): void;
  onRename(item: SessionListItemDto, title: string): void;
  onArchive(item: SessionListItemDto): void;
  onDelete(item: SessionListItemDto): void;
}) {
  const t = useT();
  const text = t.conversation.list;
  const [renaming, setRenaming] = useState<string | null>(null);
  // 正在改名时别的标签页切了语言：等改完再按新语言重建，免得改到一半的名字丢掉。
  useLossCheck(renaming !== null);
  const statuses = new Map(items.map((item) => [item.id, rowStatus(item, live)]));
  const visible = items.filter((item) => matchesFilter(statuses.get(item.id) ?? "idle", filter) && matchesSearch(item, keyword));
  const groups = groupByDay(visible, t);
  const counted = countItems ?? items;
  const countStatus = (item: SessionListItemDto) => statuses.get(item.id) ?? rowStatus(item, live);
  const runningCount = counted.filter((item) => matchesFilter(countStatus(item), "running")).length;
  const needsMeCount = counted.filter((item) => matchesFilter(countStatus(item), "needs-me")).length;

  return (
    <nav className="flex h-full min-h-0 flex-col" aria-label={text.label} data-testid="sessions-rail">
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <h2 className="m-0 flex-1 text-body font-semibold text-foreground">{text.title}</h2>
        <Button
          size="sm"
          variant="primary"
          data-testid="new-session"
          disabled={!canCreate}
          disabledReason={createDisabledReason}
          onClick={onCreate}
        >
          <PlusIcon />
          {text.create}
        </Button>
      </div>
      <div className="flex shrink-0 flex-col gap-2 px-3 pt-3 pb-2">
        <label className="relative flex items-center">
          <span className="sr-only">{text.searchLabel}</span>
          <SearchIcon className="pointer-events-none absolute left-2.5 size-3.5 text-subtle-foreground" aria-hidden="true" />
          <Input
            className="h-8 pr-7 pl-8"
            placeholder={text.searchPlaceholder}
            value={keyword}
            data-testid="session-search"
            onChange={(event) => onKeywordChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && keyword !== "") {
                event.preventDefault();
                onKeywordChange("");
              }
            }}
          />
          {keyword === "" ? null : (
            <button
              type="button"
              aria-label={text.clearSearch}
              className="absolute right-1.5 inline-flex size-5 items-center justify-center rounded-xs text-subtle-foreground hover:bg-muted hover:text-foreground"
              onClick={() => onKeywordChange("")}
            >
              <XIcon className="size-3" />
            </button>
          )}
        </label>
        <SegmentedControl
          size="sm"
          aria-label={text.filtersLabel}
          value={filter}
          onValueChange={onFilterChange}
          options={[
            { value: "all", label: text.filters.all },
            { value: "running", label: runningCount > 0 ? text.filters.runningCount(runningCount) : text.filters.running },
            { value: "needs-me", label: needsMeCount > 0 ? text.filters.needsMeCount(needsMeCount) : text.filters.needsMe },
            { value: "room-tasks", label: text.filters.roomTasks },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="flex flex-col gap-3 p-2" aria-busy="true" aria-label={text.loading}>
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="flex flex-col gap-1.5">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : null}
        {error}
        {!loading && error === null && items.length === 0 ? (
          filter === "room-tasks" ? (
            <EmptyList title={text.empty.roomTasks.title} description={text.empty.roomTasks.description} />
          ) : (
            <EmptyList title={text.empty.sessions.title} description={text.empty.sessions.description} />
          )
        ) : null}
        {!loading && items.length > 0 && visible.length === 0 ? (
          <EmptyList
            title={keyword !== "" ? text.empty.noMatch(keyword.trim()) : filter === "running" ? text.empty.noRunning : text.empty.noNeedsMe}
            description={keyword !== "" ? text.empty.noMatchHint : text.empty.filterHint}
          />
        ) : null}
        {groups.map((group) => (
          <section key={group.label} className="mt-2 flex flex-col gap-0.5" aria-label={group.label}>
            <h3 className="m-0 px-2 pb-1 text-caption font-medium text-subtle-foreground">{group.label}</h3>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {group.items.map((item) => (
                <SessionRow
                  key={item.id}
                  item={item}
                  status={statuses.get(item.id) ?? "idle"}
                  active={item.id === activeSessionId}
                  projectName={projectName(item)}
                  renaming={renaming === item.id}
                  onOpen={() => onOpen(item)}
                  onStartRename={() => setRenaming(item.id)}
                  onRename={(title) => {
                    setRenaming(null);
                    if (title !== item.title) onRename(item, title);
                  }}
                  onCancelRename={() => setRenaming(null)}
                  onArchive={() => onArchive(item)}
                  onDelete={() => onDelete(item)}
                  {...(onOpenRoom === undefined || item.roomTask == null ? {} : { onOpenRoom: () => onOpenRoom(item) })}
                />
              ))}
            </ul>
          </section>
        ))}
        {hasMore ? (
          <Button size="sm" variant="ghost" className="mt-2 w-full" loading={loadingMore} onClick={onLoadMore}>
            {text.loadMore}
          </Button>
        ) : null}
      </div>
    </nav>
  );
}

function SessionRow({
  item,
  status,
  active,
  projectName,
  renaming,
  onOpen,
  onStartRename,
  onRename,
  onCancelRename,
  onArchive,
  onDelete,
  onOpenRoom,
}: {
  item: SessionListItemDto;
  status: ReturnType<typeof rowStatus>;
  active: boolean;
  projectName: string;
  renaming: boolean;
  onOpen(): void;
  onStartRename(): void;
  onRename(title: string): void;
  onCancelRename(): void;
  onArchive(): void;
  onDelete(): void;
  onOpenRoom?(): void;
}) {
  const t = useT();
  const text = t.conversation.list.row;
  const [draft, setDraft] = useState(item.title);
  const number = item.requirement?.number ?? null;
  const roomTask = item.roomTask ?? null;
  const preview = item.preview === null ? null : `${item.preview.role === "user" ? text.previewFromYou : ""}${item.preview.text}`;
  return (
    <li
      className={cn(
        "group/row relative flex items-start rounded-md",
        active ? "bg-muted-strong" : "hover:bg-muted",
      )}
      data-testid="session-row"
      data-session-id={item.id}
      data-active={active ? "true" : "false"}
    >
      {renaming ? (
        <div className="flex w-full items-center gap-2 px-2 py-2">
          <SessionStatusDot status={status} />
          <label htmlFor={`rename-${item.id}`} className="sr-only">{text.renameLabel}</label>
          <input
            id={`rename-${item.id}`}
            className="h-7 min-w-0 flex-1 rounded-sm border border-primary bg-card px-1.5 text-small text-foreground outline-none"
            value={draft}
            maxLength={120}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => (draft.trim() === "" ? onCancelRename() : onRename(draft.trim()))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                if (draft.trim() === "") onCancelRename();
                else onRename(draft.trim());
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onCancelRename();
              }
            }}
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-current={active ? "page" : undefined}
            onClick={onOpen}
          >
            <span className="flex w-full items-center gap-2">
              <SessionStatusDot status={status} />
              <span className={cn("min-w-0 flex-1 truncate text-small", active ? "font-semibold text-foreground" : "font-medium text-foreground")}>
                {item.title || t.conversation.untitled}
              </span>
              <time className="shrink-0 text-caption text-subtle-foreground group-hover/row:invisible" dateTime={new Date(lastActivity(item)).toISOString()}>
                {formatRelativeTime(lastActivity(item))}
              </time>
            </span>
            <span className="flex w-full items-center gap-1.5 pl-5.5 text-caption text-subtle-foreground">
              {roomTask === null ? null : (
                <span className="inline-flex max-w-[50%] shrink-0 items-center gap-0.5 truncate rounded-xs bg-muted px-1 text-muted-foreground" data-testid="session-room-task">
                  <HashIcon className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{roomTask.roomName}</span>
                </span>
              )}
              {number === null || roomTask !== null ? null : (
                <span className="shrink-0 rounded-xs bg-muted px-1 font-mono text-muted-foreground">{formatRequirementNumber(number)}</span>
              )}
              {item.agentId === "codex" ? null : (
                <span className="shrink-0 rounded-xs bg-muted px-1 text-muted-foreground" title={t.agents.badge(item.agent?.displayName ?? item.agentId)} data-testid="session-row-agent">
                  {item.agent?.displayName ?? item.agentId}
                </span>
              )}
              <span className="min-w-0 truncate">{preview ?? projectName}</span>
            </span>
          </button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="absolute top-1.5 right-1.5 inline-flex size-6 items-center justify-center rounded-sm text-subtle-foreground opacity-0 outline-none group-hover/row:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:opacity-100"
                aria-label={text.moreActions(item.title)}
              >
                <MoreHorizontalIcon className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem
                onSelect={() => {
                  setDraft(item.title);
                  onStartRename();
                }}
              >
                <PencilIcon />
                {text.rename}
              </DropdownMenuItem>
              {onOpenRoom === undefined ? null : (
                <DropdownMenuItem onSelect={onOpenRoom}>
                  <MessageCircleIcon />
                  {text.openInRoom}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={onArchive}>
                <ArchiveIcon />
                {text.archive}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="danger" onSelect={onDelete}>
                <Trash2Icon />
                {text.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </li>
  );
}

function EmptyList({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center" data-testid="sessions-empty">
      <MessagesSquareIcon className="size-5 text-subtle-foreground" aria-hidden="true" />
      <p className="m-0 text-small font-medium text-foreground">{title}</p>
      <p className="m-0 text-caption text-subtle-foreground">{description}</p>
    </div>
  );
}
