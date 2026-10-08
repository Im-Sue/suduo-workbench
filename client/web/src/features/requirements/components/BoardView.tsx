import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { type RequirementListItemDto } from "@suduo/client-contracts";
import { REQUIREMENT_STATUSES, type RequirementStatus } from "@suduo/cloud-contracts";
import { PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { classifyFailure } from "../../../feedback/classify.js";
import { RegionError } from "../../../feedback/components/index.js";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusIcon } from "@/components/ui/status-icon";
import { cn } from "@/lib/utils";
import { requirementCode } from "../format.js";
import type { RequirementListFilters } from "../keys.js";
import { columnItems, columnQuery, type ColumnState } from "../queries.js";
import { RequirementCard } from "./RequirementCard.js";
import { requirementStatusLabel } from "../../../ui/requirement-status.js";
import { useT } from "../../../i18n/provider.js";
import type { Messages } from "../../../i18n/messages/index.js";

/**
 * 看板视图：每个状态一列，各自分页加载、各自骨架与错误。
 * 拖动卡片到另一列即改状态（指针拖拽）；键盘用户选中卡片后按 1–7，或用卡片上的状态菜单，效果相同。
 */
export function BoardView({
  projectId,
  filters,
  statuses,
  selectedId,
  onSelect,
  onOpen,
  onCreateIn,
  onMove,
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
  onMove(requirement: RequirementListItemDto, status: RequirementStatus): void;
}) {
  const t = useT();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [active, setActive] = useState<RequirementListItemDto | null>(null);

  const announcements = useMemo<Announcements>(() => {
    const drag = t.requirements.board.drag;
    return {
      onDragStart: ({ active: item }) => drag.pickedUp(describe(item.data.current, t)),
      onDragOver: ({ over }) => (over === null ? drag.overNone : drag.over(statusLabel(over.id, t))),
      onDragEnd: ({ active: item, over }) =>
        over === null
          ? drag.droppedUnchanged(describe(item.data.current, t))
          : drag.moved(describe(item.data.current, t), statusLabel(over.id, t)),
      onDragCancel: ({ active: item }) => drag.cancelled(describe(item.data.current, t)),
    };
  }, [t]);

  const onDragStart = (event: DragStartEvent) => {
    const requirement = (event.active.data.current as { requirement?: RequirementListItemDto } | undefined)?.requirement;
    setActive(requirement ?? null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    setActive(null);
    const requirement = (event.active.data.current as { requirement?: RequirementListItemDto } | undefined)?.requirement;
    const target = event.over?.id;
    if (requirement === undefined || typeof target !== "string") return;
    if (target !== requirement.status) onMove(requirement, target as RequirementStatus);
  };

  return (
    <DndContext
      sensors={sensors}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t.requirements.board.dragInstructions } }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActive(null)}
    >
      <div
        role="region"
        aria-label={t.requirements.board.region}
        className="flex min-h-0 min-w-0 flex-1 items-start gap-3 overflow-auto bg-background px-5 py-4"
        data-testid="requirements-board"
      >
        {statuses.map((status) => (
          <BoardColumn
            key={status}
            projectId={projectId}
            status={status}
            filters={filters}
            selectedId={selectedId}
            draggingId={active?.id ?? null}
            onSelect={onSelect}
            onOpen={onOpen}
            onCreate={() => onCreateIn(status)}
            {...(onColumnState === undefined ? {} : { onState: onColumnState })}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {active === null ? null : <RequirementCard requirement={active} overlay tabIndex={-1} className="w-[272px]" />}
      </DragOverlay>
    </DndContext>
  );
}

function statusLabel(id: unknown, t: Messages): string {
  return typeof id === "string" && (REQUIREMENT_STATUSES as readonly string[]).includes(id)
    ? requirementStatusLabel(id as RequirementStatus, t)
    : String(id);
}

function describe(data: unknown, t: Messages): string {
  const requirement = (data as { requirement?: RequirementListItemDto } | undefined)?.requirement;
  return requirement === undefined ? t.requirements.board.drag.fallbackItem : `${requirementCode(requirement.number)} ${requirement.title}`;
}

function BoardColumn({
  projectId,
  status,
  filters,
  selectedId,
  draggingId,
  onSelect,
  onOpen,
  onCreate,
  onState,
}: {
  projectId: string;
  status: RequirementStatus;
  filters: RequirementListFilters;
  selectedId: string | null;
  draggingId: string | null;
  onSelect(requirement: RequirementListItemDto): void;
  onOpen(requirement: RequirementListItemDto): void;
  onCreate(): void;
  onState?(status: RequirementStatus, state: ColumnState): void;
}) {
  const t = useT();
  const query = useInfiniteQuery(columnQuery(projectId, status, filters));
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const items = useMemo(() => columnItems(query.data), [query.data]);
  const loaded = query.data !== undefined;
  const hasMore = query.hasNextPage;
  useEffect(() => {
    onState?.(status, { count: items.length, hasMore, loaded });
  }, [onState, status, items.length, hasMore, loaded]);
  const label = requirementStatusLabel(status);
  const count = query.data === undefined ? null : `${items.length}${query.hasNextPage ? "+" : ""}`;

  return (
    <section
      aria-label={label}
      data-status-column={status}
      className="flex w-[272px] shrink-0 flex-col gap-2"
    >
      <header className="flex h-8 items-center gap-2 px-1">
        <StatusIcon status={status} aria-hidden="true" />
        <h2 className="m-0 text-small font-semibold">{label}</h2>
        {count === null ? null : <span className="text-caption text-subtle-foreground">{count}</span>}
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto size-6"
          aria-label={t.requirements.column.createIn(label)}
          onClick={onCreate}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </header>
      <div
        ref={setNodeRef}
        className={cn(
          "-m-1 flex min-h-16 flex-col gap-2 rounded-lg p-1 transition-colors",
          isOver && draggingId !== null && "bg-primary-soft/60 outline-2 outline-dashed outline-primary/40",
        )}
      >
        {query.isPending ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : null}
        {query.isError && query.data === undefined ? (
          <div className="rounded-md border border-border bg-card">
            <RegionError
              kind={classifyFailure(query.error).kind}
              message={t.requirements.column.loadFailed(label, classifyFailure(query.error).message)}
              busy={query.isFetching}
              onRetry={() => void query.refetch()}
            />
          </div>
        ) : null}
        {query.isSuccess && items.length === 0 ? (
          <p className="m-0 rounded-md border border-dashed border-border px-3 py-2.5 text-caption text-subtle-foreground">
            {t.requirements.column.empty}
          </p>
        ) : null}
        {items.map((requirement) => (
          <DraggableCard
            key={requirement.id}
            requirement={requirement}
            selected={requirement.id === selectedId}
            dragging={requirement.id === draggingId}
            onSelect={onSelect}
            onOpen={onOpen}
          />
        ))}
        {query.hasNextPage ? (
          <Button
            variant="ghost"
            size="sm"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {t.requirements.column.loadMore}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function DraggableCard({
  requirement,
  selected,
  dragging,
  onSelect,
  onOpen,
}: {
  requirement: RequirementListItemDto;
  selected: boolean;
  dragging: boolean;
  onSelect(requirement: RequirementListItemDto): void;
  onOpen(requirement: RequirementListItemDto): void;
}) {
  // 只接指针拖拽的监听；键盘语义仍是普通按钮（Enter 打开、1–7 改状态）。
  const { setNodeRef, listeners } = useDraggable({ id: requirement.id, data: { requirement } });
  return (
    <RequirementCard
      ref={setNodeRef}
      requirement={requirement}
      selected={selected}
      dragging={dragging}
      onFocus={() => onSelect(requirement)}
      onClick={() => onOpen(requirement)}
      {...listeners}
    />
  );
}

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2.5" aria-hidden="true">
      <Skeleton className="h-3 w-14" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-3 w-3/5" />
    </div>
  );
}
