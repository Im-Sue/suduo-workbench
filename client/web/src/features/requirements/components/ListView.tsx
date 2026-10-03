import { useInfiniteQuery } from "@tanstack/react-query";
import { type RequirementListItemDto } from "@suduo/client-contracts";
import { REQUIREMENT_STATUS_LABELS, type RequirementStatus } from "@suduo/cloud-contracts";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { classifyFailure } from "../../../feedback/classify.js";
import { RegionError } from "../../../feedback/components/index.js";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusIcon } from "@/components/ui/status-icon";
import { cn } from "@/lib/utils";
import { formatFullTime, formatRelativeTime, requirementCode } from "../format.js";
import type { RequirementListFilters } from "../keys.js";
import { columnQuery, type ColumnState } from "../queries.js";
import { useRecentlyChanged } from "../highlight.js";
import { UserAvatar } from "./UserAvatar.js";

/**
 * 列表视图：按状态分组（可折叠），与看板共用每个状态的分页查询，切换视图不重新加载。
 * 行是按钮：点击或 Enter 打开速览，↑↓ / J K 移动，1–7 改状态。
 */
export function ListView({
  projectId,
  filters,
  statuses,
  selectedId,
  onSelect,
  onOpen,
  onCreateIn,
  onColumnState,
}: {
  projectId: string;
  filters: RequirementListFilters;
  statuses: readonly RequirementStatus[];
  selectedId: string | null;
  onSelect(requirement: RequirementListItemDto): void;
  onOpen(requirement: RequirementListItemDto): void;
  onCreateIn(status: RequirementStatus): void;
  /** 每列载入结果（条数、是否还有下一页），页面用来显示总数和「没有找到」。 */
  onColumnState?(status: RequirementStatus, state: ColumnState): void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<RequirementStatus>>(new Set());
  const toggle = (status: RequirementStatus) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });

  return (
    <div role="region" aria-label="需求列表" className="min-h-0 min-w-0 flex-1 overflow-auto" data-testid="requirements-list">
      <div className="sticky top-0 z-10 flex h-8 items-center gap-3 border-b border-border bg-card px-5 text-caption text-subtle-foreground">
        <span className="w-[72px] shrink-0">编号</span>
        <span className="min-w-0 flex-1">标题</span>
        <span className="w-28 shrink-0">负责人</span>
        <span className="w-28 shrink-0">材料 · 评论 · 会话</span>
        <span className="w-20 shrink-0 text-right">更新</span>
      </div>
      {statuses.map((status) => (
        <ListGroup
          key={status}
          projectId={projectId}
          status={status}
          filters={filters}
          collapsed={collapsed.has(status)}
          onToggle={() => toggle(status)}
          selectedId={selectedId}
          onSelect={onSelect}
          onOpen={onOpen}
          onCreate={() => onCreateIn(status)}
          {...(onColumnState === undefined ? {} : { onState: onColumnState })}
        />
      ))}
    </div>
  );
}

function ListGroup({
  projectId,
  status,
  filters,
  collapsed,
  onToggle,
  selectedId,
  onSelect,
  onOpen,
  onCreate,
  onState,
}: {
  projectId: string;
  status: RequirementStatus;
  filters: RequirementListFilters;
  collapsed: boolean;
  onToggle(): void;
  selectedId: string | null;
  onSelect(requirement: RequirementListItemDto): void;
  onOpen(requirement: RequirementListItemDto): void;
  onCreate(): void;
  onState?(status: RequirementStatus, state: ColumnState): void;
}) {
  const query = useInfiniteQuery(columnQuery(projectId, status, filters));
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const loaded = query.data !== undefined;
  const hasMore = query.hasNextPage;
  useEffect(() => {
    onState?.(status, { count: items.length, hasMore, loaded });
  }, [onState, status, items.length, hasMore, loaded]);
  const label = REQUIREMENT_STATUS_LABELS[status];
  // 筛选后没有条目的组整组隐藏，减少噪音；未筛选时保留空组，方便就地新建。
  const filtered = (filters.search ?? "") !== "" || filters.assignee !== undefined;
  if (filtered && query.isSuccess && items.length === 0) return null;

  return (
    <section aria-label={label} data-status-column={status}>
      <div className="group/header flex h-[34px] items-center gap-2 border-b border-border bg-background px-5">
        <button
          type="button"
          aria-expanded={!collapsed}
          className="-ml-1.5 flex items-center gap-2 rounded-sm px-1.5 py-0.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onToggle}
        >
          <ChevronRightIcon
            className={cn("size-3.5 text-subtle-foreground transition-transform", !collapsed && "rotate-90")}
            aria-hidden="true"
          />
          <StatusIcon status={status} aria-hidden="true" />
          <span className="text-small font-semibold">{label}</span>
          {query.data === undefined ? null : (
            <span className="text-caption text-subtle-foreground">
              {items.length}
              {query.hasNextPage ? "+" : ""}
            </span>
          )}
        </button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto size-6 opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
          aria-label={`在「${label}」新建需求`}
          onClick={onCreate}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
      {collapsed ? null : (
        <>
          {query.isPending ? <RowSkeleton /> : null}
          {query.isError && query.data === undefined ? (
            <RegionError
              kind={classifyFailure(query.error).kind}
              message={`没能加载「${label}」：${classifyFailure(query.error).message}`}
              busy={query.isFetching}
              onRetry={() => void query.refetch()}
            />
          ) : null}
          {query.isSuccess && items.length === 0 ? (
            <p className="m-0 border-b border-border px-5 py-2.5 text-caption text-subtle-foreground">暂无</p>
          ) : null}
          {items.map((requirement) => (
            <ListRow
              key={requirement.id}
              requirement={requirement}
              selected={requirement.id === selectedId}
              onFocus={() => onSelect(requirement)}
              onClick={() => onOpen(requirement)}
            />
          ))}
          {query.hasNextPage ? (
            <div className="border-b border-border px-5 py-1.5">
              <Button variant="ghost" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                加载更多
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function ListRow({
  requirement,
  selected,
  onFocus,
  onClick,
}: {
  requirement: RequirementListItemDto;
  selected: boolean;
  onFocus(): void;
  onClick(): void;
}) {
  const changed = useRecentlyChanged(requirement.id);
  const code = requirementCode(requirement.number);
  return (
    <button
      type="button"
      data-requirement-id={requirement.id}
      data-requirement-number={requirement.number}
      data-testid="requirement-row"
      aria-label={`${code} ${requirement.title}`}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex h-10 w-full items-center gap-3 border-b border-border bg-card px-5 text-left outline-none",
        "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected && "bg-primary-soft hover:bg-primary-soft",
        changed && "animate-flash",
      )}
      onFocus={onFocus}
      onClick={onClick}
    >
      <span className="w-[72px] shrink-0 font-mono text-caption text-subtle-foreground">{code}</span>
      <span className="min-w-0 flex-1 truncate text-body font-medium">{requirement.title}</span>
      <span className="flex w-28 shrink-0 items-center gap-1.5 text-small">
        <UserAvatar user={requirement.assignee} />
        <span className={cn("truncate", requirement.assignee === null && "text-subtle-foreground")}>
          {requirement.assignee?.displayName ?? "未指派"}
        </span>
      </span>
      <span className="w-28 shrink-0 font-mono text-caption text-subtle-foreground">
        {requirement.attachmentCount} · {requirement.commentCount} · {requirement.localSessionCount}
      </span>
      <time
        className="w-20 shrink-0 text-right text-caption text-subtle-foreground"
        dateTime={requirement.updatedAt}
        title={formatFullTime(requirement.updatedAt)}
      >
        {formatRelativeTime(requirement.updatedAt)}
      </time>
    </button>
  );
}

function RowSkeleton() {
  return (
    <div className="flex h-10 items-center gap-3 border-b border-border px-5" aria-hidden="true">
      <Skeleton className="h-3 w-12" />
      <Skeleton className="h-3.5 w-2/5" />
    </div>
  );
}
