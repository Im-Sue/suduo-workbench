import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type RequirementListItemDto } from "@suduo/client-contracts";
import {
  REQUIREMENT_ASSIGNEE_FILTER_ME,
  REQUIREMENT_ASSIGNEE_FILTER_NONE,
  REQUIREMENT_STATUSES,
  type RequirementStatus,
} from "@suduo/cloud-contracts";
import {
  CheckIcon,
  ColumnsIcon,
  ListIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useCurrentProject } from "../../app/project-context.js";
import { settingsQuery } from "../../app/queries.js";
import { useSessionLauncher } from "../../app/shell/SessionLauncher.js";
import { requestProjectAction } from "../../app/shell/shell-actions.js";
import { EmptyState } from "../../feedback/components/index.js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusIcon } from "@/components/ui/status-icon";
import { cn } from "@/lib/utils";
import { BoardView } from "./components/BoardView.js";
import { CreateRequirementDialog } from "./components/CreateRequirementDialog.js";
import { ListView } from "./components/ListView.js";
import { RequirementPeek } from "./components/RequirementPeek.js";
import { requirementCode } from "./format.js";
import type { RequirementListFilters } from "./keys.js";
import { findCachedItem, usersQuery, useRequirementIdByRef, useUpdateRequirement, type ColumnState } from "./queries.js";
import { useRequirementsRealtimeState } from "./realtime.js";
import { requirementStatusLabel } from "../../ui/requirement-status.js";
import { useCarried, useCarrySource, useT } from "../../i18n/provider.js";

/**
 * 需求页（原型 Main）：看板 / 列表 + 右侧速览。筛选、视图、速览都记在 URL 里，可分享、可回退。
 * 键盘：C 新建，/ 搜索，J K（或 ↑↓）移动，Enter 打开速览，1–7 改状态，Esc 关闭速览。
 */
export type RequirementsView = "board" | "list";

export interface RequirementsSearch {
  view?: RequirementsView;
  q?: string;
  status?: RequirementStatus;
  /** me / none / 用户 id */
  assignee?: string;
  /** 速览中的需求编号（数字；旧链接里也可能是需求 id） */
  peek?: number | string;
}

/** URL 参数的局部修改：值为 undefined 表示去掉该参数。 */
type SearchPatch = { [K in keyof RequirementsSearch]?: RequirementsSearch[K] | undefined };

export function validateRequirementsSearch(search: Record<string, unknown>): RequirementsSearch {
  const result: RequirementsSearch = {};
  if (search["view"] === "board" || search["view"] === "list") result.view = search["view"];
  // 手写的 ?q=128 会被解析成数字，同样接受。
  const q = typeof search["q"] === "number" ? String(search["q"]) : search["q"];
  if (typeof q === "string" && q.trim() !== "") result.q = q.slice(0, 200);
  const status = search["status"];
  if (typeof status === "string" && (REQUIREMENT_STATUSES as readonly string[]).includes(status)) {
    result.status = status as RequirementStatus;
  }
  if (typeof search["assignee"] === "string" && search["assignee"] !== "") result.assignee = search["assignee"];
  const peek = search["peek"];
  if (typeof peek === "number" && Number.isInteger(peek) && peek > 0) result.peek = peek;
  else if (typeof peek === "string" && /^\d+$/.test(peek)) result.peek = Number(peek);
  else if (typeof peek === "string" && peek !== "") result.peek = peek;
  return result;
}

const VIEW_KEY = "suduo.requirements.view";

function readStoredView(): RequirementsView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board";
  } catch {
    return "board";
  }
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
  );
}

/** 有对话框、菜单或弹层开着时，页面快捷键让位。 */
function overlayOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"], [role="menu"], [role="listbox"][data-state="open"]') !== null;
}

export function RequirementsPage({ projectId }: { projectId: string }) {
  const t = useT();
  const search = useSearch({ strict: false }) as RequirementsSearch;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { project } = useCurrentProject();
  const settings = useQuery(settingsQuery);
  const launcher = useSessionLauncher();
  const update = useUpdateRequirement();
  const realtime = useRequirementsRealtimeState();
  const currentUser = settings.data?.session?.user ?? null;
  const me = useMemo(
    () => (currentUser === null ? null : { id: currentUser.id, displayName: currentUser.displayName }),
    [currentUser],
  );

  const view: RequirementsView = search.view ?? readStoredView();
  const filters = useMemo<RequirementListFilters>(
    () => ({
      ...(search.q === undefined ? {} : { search: search.q }),
      ...(search.assignee === undefined ? {} : { assignee: search.assignee }),
    }),
    [search.q, search.assignee],
  );
  const statuses = search.status === undefined ? REQUIREMENT_STATUSES : [search.status];

  const setSearch = useCallback(
    (patch: SearchPatch, options: { replace?: boolean } = {}) => {
      void navigate({
        to: "/p/$projectId/requirements",
        params: { projectId },
        search: (previous: RequirementsSearch) => {
          const next: Record<string, unknown> = { ...previous, ...patch };
          for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
          return next as RequirementsSearch;
        },
        replace: options.replace ?? true,
      });
    },
    [navigate, projectId],
  );

  const setView = (next: RequirementsView) => {
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // 记不住视图偏好不影响使用。
    }
    setSearch({ view: next });
  };

  // ---------- 搜索（输入防抖后写入 URL） ----------
  // 还没写进地址的搜索词（防抖 250ms）带过语言切换的重建；写进地址的本来就在（i18n/carry.ts）。
  const carriedQuery = useCarried<string>(`requirements-query:${projectId}`);
  const [query, setQuery] = useState(carriedQuery ?? search.q ?? "");
  useCarrySource(`requirements-query:${projectId}`, () => query);
  const [composing, setComposing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // 自己写进 URL 的值回流时不覆盖输入框：否则写入瞬间继续敲的字、词间空格会被吞掉。
  const written = useRef(search.q);
  useEffect(() => {
    if (search.q === written.current) return;
    written.current = search.q;
    setQuery(search.q ?? "");
  }, [search.q]);
  useEffect(() => {
    if (composing) return undefined; // 拼音输入的中间态不查询。
    const trimmed = query.trim();
    if (trimmed === (search.q ?? "")) return undefined;
    const timer = window.setTimeout(() => {
      const next = trimmed === "" ? undefined : trimmed;
      written.current = next;
      setSearch({ q: next });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, composing, search.q, setSearch]);
  const clearSearch = (patch: SearchPatch = {}) => {
    setQuery("");
    written.current = undefined;
    setSearch({ q: undefined, ...patch });
  };

  // ---------- 各列载入结果 ----------
  const [columns, setColumns] = useState<Partial<Record<RequirementStatus, ColumnState>>>({});
  const onColumnState = useCallback((status: RequirementStatus, state: ColumnState) => {
    setColumns((current) => {
      const previous = current[status];
      if (previous?.count === state.count && previous.hasMore === state.hasMore && previous.loaded === state.loaded) {
        return current;
      }
      return { ...current, [status]: state };
    });
  }, []);
  const visible = statuses.map((status) => columns[status]);
  const allLoaded = visible.every((state) => state?.loaded === true);
  const total = visible.reduce((sum, state) => sum + (state?.count ?? 0), 0);
  const totalLabel = allLoaded ? t.requirements.page.total(total, visible.some((state) => state?.hasMore === true)) : null;
  const filtered = search.q !== undefined || search.assignee !== undefined || search.status !== undefined;
  const noResult = filtered && allLoaded && total === 0;

  // ---------- 选中与速览 ----------
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 筛选变了，之前点过的那条可能已不在视图里：不再把它当作选中项。
  useEffect(() => setSelectedId(null), [filters, search.status]);
  const viewRef = useRef<HTMLDivElement>(null);
  const peek = useRequirementIdByRef(projectId, search.peek === undefined ? null : String(search.peek));
  const peekId = peek.id;
  // 速览是盖在看板上的浮层时（窄屏），打开后把焦点移进面板。
  const [focusPeek, setFocusPeek] = useState(false);
  const openPeek = useCallback(
    (requirement: RequirementListItemDto) => {
      setSelectedId(requirement.id);
      setFocusPeek(!window.matchMedia("(min-width: 1440px)").matches);
      setSearch({ peek: requirement.number });
    },
    [setSearch],
  );
  const closePeek = useCallback(() => {
    const id = peekId;
    setSearch({ peek: undefined });
    // 焦点回到对应的卡片 / 行。
    if (id !== null) {
      window.requestAnimationFrame(() => {
        viewRef.current?.querySelector<HTMLElement>(`[data-requirement-id="${id}"]`)?.focus();
      });
    }
  }, [peekId, setSearch]);

  const itemElements = () =>
    Array.from(viewRef.current?.querySelectorAll<HTMLElement>("[data-requirement-id]") ?? []);

  const neighbour = (id: string | null, delta: 1 | -1): HTMLElement | null => {
    const elements = itemElements();
    if (elements.length === 0) return null;
    const index = id === null ? -1 : elements.findIndex((element) => element.dataset["requirementId"] === id);
    if (index === -1) return delta === 1 ? (elements[0] ?? null) : null;
    return elements[index + delta] ?? null;
  };

  const moveTo = (element: HTMLElement | null) => {
    if (element === null) return;
    element.focus();
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const number = Number(element.dataset["requirementNumber"]);
    if (search.peek !== undefined && Number.isInteger(number) && number > 0) {
      setFocusPeek(false);
      setSearch({ peek: number });
    }
  };

  /** 数字键改状态的对象：获得焦点的卡片 / 行，其次是速览里那条；只认本项目、且确实在界面上的。 */
  const current = (focusedId: string | null): RequirementListItemDto | undefined => {
    const id = focusedId ?? (search.peek !== undefined ? peekId : null);
    if (id === null) return undefined;
    const item = findCachedItem(queryClient, id);
    return item?.projectId === projectId ? item : undefined;
  };

  // ---------- 新建 ----------
  const [creating, setCreating] = useState<{ status: RequirementStatus } | null>(null);
  const createIn = (status: RequirementStatus) => setCreating({ status });

  const startSession = (requirement: RequirementListItemDto) =>
    launcher.launch({
      kind: "requirement",
      remoteProjectId: projectId,
      requirementId: requirement.id,
      subject: `${requirementCode(requirement.number)} ${requirement.title}`,
    });

  // ---------- 键盘 ----------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (isTyping(event.target) || overlayOpen()) return;
      const key = event.key;
      if (key === "c" || key === "C") {
        event.preventDefault();
        createIn(search.status ?? "draft");
        return;
      }
      if (key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (key === "Escape" && search.peek !== undefined) {
        event.preventDefault();
        closePeek();
        return;
      }
      const focusedId =
        document.activeElement instanceof HTMLElement ? (document.activeElement.dataset["requirementId"] ?? null) : null;
      const anchor = focusedId ?? (search.peek !== undefined ? peekId : selectedId);
      if (key === "j" || key === "J" || key === "ArrowDown") {
        event.preventDefault();
        moveTo(neighbour(anchor, 1));
        return;
      }
      if (key === "k" || key === "K" || key === "ArrowUp") {
        event.preventDefault();
        moveTo(neighbour(anchor, -1));
        return;
      }
      if ((key === "ArrowLeft" || key === "ArrowRight") && view === "board" && focusedId !== null) {
        event.preventDefault();
        moveTo(sideways(viewRef.current, focusedId, key === "ArrowLeft" ? -1 : 1));
        return;
      }
      const statusIndex = Number(key) - 1;
      const nextStatus = REQUIREMENT_STATUSES[statusIndex];
      if (nextStatus !== undefined && /^[1-7]$/.test(key)) {
        const requirement = current(focusedId);
        if (requirement === undefined || requirement.status === nextStatus) return;
        event.preventDefault();
        update.mutate({ requirement, patch: { status: nextStatus } });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const peekNeighbour = (delta: 1 | -1) => {
    const element = neighbour(peekId, delta);
    return element === null ? null : () => moveTo(element);
  };

  const users = useQuery({ ...usersQuery, enabled: search.assignee !== undefined && !isReservedAssignee(search.assignee) });
  const assigneeLabel =
    search.assignee === undefined
      ? null
      : search.assignee === REQUIREMENT_ASSIGNEE_FILTER_ME
        ? t.requirements.filter.mine
        : search.assignee === REQUIREMENT_ASSIGNEE_FILTER_NONE
          ? t.requirements.assignee.unassigned
          : (users.data?.items.find((user) => user.id === search.assignee)?.displayName ?? t.requirements.filter.someone);

  return (
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden" data-testid="requirements-page">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border pr-4 pl-5">
        <h1 className="m-0 text-section font-semibold">{t.requirements.page.title}</h1>
        {totalLabel === null ? null : <span className="text-caption text-subtle-foreground">{totalLabel}</span>}
        <SegmentedControl
          className="ml-2"
          size="sm"
          aria-label={t.requirements.page.view}
          data-testid="requirements-view-switch"
          value={view}
          onValueChange={setView}
          options={[
            { value: "board", label: t.requirements.page.viewBoard, icon: <ColumnsIcon className="size-3.5" /> },
            { value: "list", label: t.requirements.page.viewList, icon: <ListIcon className="size-3.5" /> },
          ]}
        />
        <div className="flex-1" />
        {realtime === "reconnecting" ? (
          <span className="text-caption text-warning" role="status">{t.requirements.page.reconnecting}</span>
        ) : null}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label={t.requirements.page.moreActions}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => requestProjectAction("manage")}>
              <SettingsIcon />
              {t.requirements.page.projectSettings}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="primary" onClick={() => createIn(search.status ?? "draft")} data-testid="create-requirement">
          <PlusIcon />
          {t.requirements.page.create}
          <Kbd className="ml-1">C</Kbd>
        </Button>
      </header>

      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border pr-4 pl-5">
        <label className="relative flex w-62 items-center">
          <span className="sr-only">{t.requirements.page.searchLabel}</span>
          <SearchIcon className="pointer-events-none absolute left-2.5 size-3.5 text-subtle-foreground" aria-hidden="true" />
          <Input
            ref={searchRef}
            className="h-7 pr-7 pl-8"
            placeholder={t.requirements.page.searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                clearSearch();
                event.currentTarget.blur();
              }
            }}
          />
          {query === "" ? (
            <Kbd className="pointer-events-none absolute right-2">/</Kbd>
          ) : (
            <button
              type="button"
              aria-label={t.requirements.page.clearSearch}
              className="absolute right-1.5 inline-flex size-5 items-center justify-center rounded-xs text-subtle-foreground hover:bg-muted hover:text-foreground"
              onClick={() => clearSearch()}
            >
              <XIcon className="size-3" />
            </button>
          )}
        </label>

        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <FilterChip active={search.status !== undefined}>
              {search.status === undefined ? (
                <>
                  <PlusIcon className="size-3.5" />
                  {t.requirements.filter.status}
                </>
              ) : (
                <>
                  <StatusIcon status={search.status} aria-hidden="true" className="size-3.5" />
                  {t.requirements.filter.statusValue(requirementStatusLabel(search.status))}
                </>
              )}
            </FilterChip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {REQUIREMENT_STATUSES.map((status) => (
              <DropdownMenuItem key={status} onSelect={() => setSearch({ status: search.status === status ? undefined : status })}>
                <StatusIcon status={status} aria-hidden="true" />
                <span className="flex-1">{requirementStatusLabel(status)}</span>
                {search.status === status ? <CheckIcon className="size-4 text-primary-text!" /> : null}
              </DropdownMenuItem>
            ))}
            {search.status === undefined ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setSearch({ status: undefined })}>{t.requirements.filter.allStatuses}</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <FilterChip active={search.assignee !== undefined}>
              {assigneeLabel === null ? (
                <>
                  <PlusIcon className="size-3.5" />
                  {t.requirements.filter.assignee}
                </>
              ) : (
                <>
                  <UserRoundIcon className="size-3.5" />
                  {t.requirements.filter.assigneeValue(assigneeLabel)}
                </>
              )}
            </FilterChip>
          </DropdownMenuTrigger>
          <AssigneeFilterMenu
            value={search.assignee}
            currentUserId={me?.id ?? null}
            onChange={(assignee) => setSearch({ assignee })}
          />
        </DropdownMenu>

        {filtered ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => clearSearch({ status: undefined, assignee: undefined })}
          >
            {t.requirements.page.clearFilters}
          </Button>
        ) : null}
      </div>

      <div ref={viewRef} className="relative flex min-h-0 flex-1">
        {noResult ? (
          <div className="flex flex-1 items-center justify-center bg-background">
            <EmptyState
              size="page"
              title={search.q === undefined ? t.requirements.noResult.filteredTitle : t.requirements.noResult.searchTitle(search.q)}
              description={
                search.q === undefined ? t.requirements.noResult.filteredDescription : t.requirements.noResult.searchDescription
              }
              action={{
                label: t.requirements.page.clearFilters,
                onClick: () => clearSearch({ status: undefined, assignee: undefined }),
              }}
            />
          </div>
        ) : null}
        <div className={cn("flex min-h-0 min-w-0 flex-1", noResult && "hidden")}>
          {view === "board" ? (
            <BoardView
              projectId={projectId}
              filters={filters}
              statuses={statuses}
              selectedId={search.peek === undefined ? selectedId : peekId}
              onSelect={(requirement) => setSelectedId(requirement.id)}
              onOpen={openPeek}
              onCreateIn={createIn}
              onMove={(requirement, status) => update.mutate({ requirement, patch: { status } })}
              onColumnState={onColumnState}
            />
          ) : (
            <ListView
              projectId={projectId}
              filters={filters}
              statuses={statuses}
              selectedId={search.peek === undefined ? selectedId : peekId}
              onSelect={(requirement) => setSelectedId(requirement.id)}
              onOpen={openPeek}
              onCreateIn={createIn}
              onColumnState={onColumnState}
            />
          )}
        </div>
        {search.peek === undefined ? null : peekId === null ? (
          <PeekMissing
            label={peek.number === null ? t.requirements.peekMissing.quoted(String(search.peek)) : requirementCode(peek.number)}
            state={peek.invalid || peek.notFound ? "not_found" : peek.lookup.isError ? "failed" : "loading"}
            busy={peek.lookup.isFetching}
            onRetry={() => void peek.lookup.refetch()}
            onClose={closePeek}
          />
        ) : (
          <RequirementPeek
            key="peek"
            projectId={projectId}
            requirementId={peekId}
            focusOnOpen={focusPeek}
            currentUserId={me?.id ?? null}
            onClose={closePeek}
            onPrev={peekNeighbour(-1)}
            onNext={peekNeighbour(1)}
            onStartSession={startSession}
          />
        )}
      </div>

      <CreateRequirementDialog
        open={creating !== null}
        onOpenChange={(open) => !open && setCreating(null)}
        projectId={projectId}
        projectName={project?.name ?? ""}
        initialStatus={creating?.status ?? "draft"}
        currentUser={me}
        onView={openPeek}
      />
    </div>
  );
}

function isReservedAssignee(value: string): boolean {
  return value === REQUIREMENT_ASSIGNEE_FILTER_ME || value === REQUIREMENT_ASSIGNEE_FILTER_NONE;
}

/** 看板里 ←/→：移到相邻列里同一高度的卡片（该列较短时取最后一张）。 */
function sideways(root: HTMLElement | null, id: string, delta: 1 | -1): HTMLElement | null {
  if (root === null) return null;
  const columns = Array.from(root.querySelectorAll<HTMLElement>("[data-status-column]"));
  const from = columns.findIndex((column) => column.querySelector(`[data-requirement-id="${id}"]`) !== null);
  if (from === -1) return null;
  const cards = (column: HTMLElement) => Array.from(column.querySelectorAll<HTMLElement>("[data-requirement-id]"));
  const row = cards(columns[from]!).findIndex((card) => card.dataset["requirementId"] === id);
  for (let index = from + delta; index >= 0 && index < columns.length; index += delta) {
    const target = cards(columns[index]!);
    if (target.length > 0) return target[Math.min(row, target.length - 1)] ?? null;
  }
  return null;
}

function FilterChip({ active, children, ...props }: { active: boolean; children: ReactNode } & ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-sm border px-2.5 text-caption font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-transparent bg-primary-soft text-primary-text"
          : "border-dashed border-border-strong text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function AssigneeFilterMenu({
  value,
  currentUserId,
  onChange,
}: {
  value: string | undefined;
  currentUserId: string | null;
  onChange(value: string | undefined): void;
}) {
  const t = useT();
  const users = useQuery(usersQuery);
  const pick = (next: string) => onChange(value === next ? undefined : next);
  const check = (candidate: string) => (value === candidate ? <CheckIcon className="size-4 text-primary-text!" /> : null);
  return (
    <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
      <DropdownMenuItem onSelect={() => pick(REQUIREMENT_ASSIGNEE_FILTER_ME)}>
        <span className="flex-1">{t.requirements.filter.mine}</span>
        {check(REQUIREMENT_ASSIGNEE_FILTER_ME)}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => pick(REQUIREMENT_ASSIGNEE_FILTER_NONE)}>
        <span className="flex-1">{t.requirements.assignee.unassigned}</span>
        {check(REQUIREMENT_ASSIGNEE_FILTER_NONE)}
      </DropdownMenuItem>
      {(users.data?.items ?? []).filter((user) => user.id !== currentUserId).length > 0 ? <DropdownMenuSeparator /> : null}
      {(users.data?.items ?? [])
        .filter((user) => user.id !== currentUserId)
        .map((user) => (
          <DropdownMenuItem key={user.id} onSelect={() => pick(user.id)}>
            <span className="flex-1 truncate">{user.displayName}</span>
            {check(user.id)}
          </DropdownMenuItem>
        ))}
      {value === undefined ? null : (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onChange(undefined)}>{t.requirements.filter.anyAssignee}</DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  );
}

function PeekMissing({
  label,
  state,
  busy,
  onRetry,
  onClose,
}: {
  label: string;
  state: "loading" | "not_found" | "failed";
  busy: boolean;
  onRetry(): void;
  onClose(): void;
}) {
  const t = useT();
  return (
    <aside
      aria-label={t.requirements.peek.label}
      aria-busy={state === "loading" || undefined}
      className="absolute inset-y-0 right-0 z-20 flex w-[min(480px,100%)] flex-col items-center justify-center gap-3 border-l border-border bg-card p-6 text-center shadow-2 min-[1440px]:static min-[1440px]:w-[480px] min-[1440px]:shrink-0 min-[1440px]:shadow-none"
    >
      {state === "loading" ? (
        <div className="flex w-full flex-col gap-4 self-stretch">
          <Skeleton className="h-6 w-4/5" />
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : state === "not_found" ? (
        <>
          <p className="m-0 text-body font-medium">{t.requirements.peekMissing.notFound(label)}</p>
          <p className="m-0 text-small text-muted-foreground">{t.requirements.peekMissing.notFoundDetail}</p>
          <Button variant="secondary" onClick={onClose}>{t.feedback.dialog.close}</Button>
        </>
      ) : (
        <>
          <p className="m-0 text-body font-medium">{t.requirements.peekMissing.failed(label)}</p>
          <p className="m-0 text-small text-muted-foreground">{t.requirements.peekMissing.failedDetail}</p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>{t.feedback.dialog.close}</Button>
            <Button variant="primary" loading={busy} onClick={onRetry}>{t.feedback.retry}</Button>
          </div>
        </>
      )}
    </aside>
  );
}
