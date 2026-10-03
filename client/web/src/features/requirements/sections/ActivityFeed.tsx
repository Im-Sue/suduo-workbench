import { useInfiniteQuery } from "@tanstack/react-query";
import {
  REQUIREMENT_STATUS_LABELS,
  type RequirementActivityEntryDto,
} from "@suduo/cloud-contracts";
import { ArrowRightIcon } from "lucide-react";
import { useEffect, useMemo, type ReactNode } from "react";
import { classifyFailure } from "../../../feedback/classify.js";
import { RegionError } from "../../../feedback/components/index.js";
import { Markdown } from "../../../ui/markdown.js";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusIcon } from "@/components/ui/status-icon";
import { cn } from "@/lib/utils";
import { presentActivity, type ActivityKind } from "../activity.js";
import { activityQuery } from "../queries.js";
import { UserAvatar } from "../components/UserAvatar.js";
import { formatDateTime, formatRelativeTime } from "../../../ui/format.js";

export type ActivityFilter = "all" | "comments" | "changes";

const COMMENT_KINDS: ReadonlySet<ActivityKind> = new Set(["comment"]);

/**
 * 需求活动。
 * - recent：速览里的「最近活动」，最新在前，只显示前几条；
 * - timeline：详情页时间线，从早到晚排列，顶部「更早的记录 · 加载更多」，底部接评论框。
 */
export function ActivityFeed({
  requirementId,
  mode,
  filter = "all",
  limit = 5,
  footer,
  onShownComments,
}: {
  requirementId: string;
  mode: "recent" | "timeline";
  filter?: ActivityFilter;
  limit?: number;
  /** 时间线末尾追加的内容（发送中的评论）。 */
  footer?: ReactNode;
  /**
   * 界面上实际显示出来的最新一条评论的时间（评论被筛掉或还没取到时为 null）。
   * 详情页据此记已读：只把「看到的」记为已读。
   */
  onShownComments?(latestCommentAt: string | null): void;
}) {
  const query = useInfiniteQuery(activityQuery(requirementId));
  const entries = useMemo(() => {
    const all = query.data?.pages.flatMap((page) => page.items) ?? [];
    const filtered = all.filter((entry) => {
      if (filter === "all") return true;
      const comment = COMMENT_KINDS.has(presentActivity(entry).kind);
      return filter === "comments" ? comment : !comment;
    });
    return mode === "recent" ? filtered.slice(0, limit) : filtered.toReversed();
  }, [query.data, filter, mode, limit]);

  const latestShownComment = useMemo(() => {
    let latest: string | null = null;
    for (const entry of entries) {
      if (!COMMENT_KINDS.has(presentActivity(entry).kind)) continue;
      if (latest === null || Date.parse(entry.createdAt) > Date.parse(latest)) latest = entry.createdAt;
    }
    return latest;
  }, [entries]);
  useEffect(() => {
    if (!query.isPending) onShownComments?.(latestShownComment);
  }, [latestShownComment, onShownComments, query.isPending]);

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <EntrySkeleton />
        <EntrySkeleton />
      </div>
    );
  }
  if (query.isError && query.data === undefined) {
    const failure = classifyFailure(query.error);
    return (
      <RegionError
        kind={failure.kind}
        message={`没能加载活动：${failure.message}`}
        busy={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <ol className={cn("m-0 flex list-none flex-col p-0", mode === "recent" ? "gap-2.5" : "gap-4")} aria-label="活动">
      {mode === "timeline" && query.hasNextPage ? (
        <li>
          <Button variant="ghost" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            更早的记录 · 加载更多
          </Button>
        </li>
      ) : null}
      {entries.length === 0 ? (
        <li className="text-caption text-subtle-foreground">
          {query.hasNextPage
            ? `最近的记录里没有${filter === "comments" ? "评论" : filter === "changes" ? "变更" : "活动"}${mode === "timeline" ? "，更早的可以加载更多" : ""}`
            : filter === "comments" ? "还没有评论" : filter === "changes" ? "还没有变更" : "还没有活动"}
        </li>
      ) : null}
      {entries.map((entry) => (
        <ActivityEntry key={entry.id} entry={entry} compact={mode === "recent"} />
      ))}
      {footer}
    </ol>
  );
}

function ActivityEntry({ entry, compact }: { entry: RequirementActivityEntryDto; compact: boolean }) {
  const view = presentActivity(entry);
  const time = (
    <time className="text-caption text-subtle-foreground" dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>
      {formatRelativeTime(entry.createdAt)}
    </time>
  );
  if (view.kind === "comment" && !compact) {
    return (
      <li className="flex gap-2.5" data-testid="activity-comment">
        <UserAvatar user={entry.actor} size="lg" className="mt-0.5" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline gap-1.5 text-small">
            <strong className="font-semibold">{entry.actor.displayName}</strong>
            {time}
          </div>
          <div className="rounded-md border border-border bg-card px-3 py-2 text-body">
            <Markdown text={view.body ?? ""} />
          </div>
        </div>
      </li>
    );
  }
  return (
    <li className="flex gap-2.5 text-small">
      <UserAvatar user={entry.actor} size={compact ? "md" : "lg"} className={compact ? "mt-px" : "mt-0.5"} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn(compact ? "" : "leading-7")}>
          <strong className="font-semibold">{entry.actor.displayName}</strong>{" "}
          {view.status === undefined ? (
            <span className="text-muted-foreground">{view.text}</span>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-1 text-muted-foreground">
              修改了状态
              <StatusChip status={view.status.from} />
              <ArrowRightIcon className="size-3" aria-label="改为" />
              <StatusChip status={view.status.to} />
            </span>
          )}
          {compact ? null : <> · {time}</>}
        </span>
        {compact ? time : null}
        {view.body !== null && (compact || view.kind !== "comment") ? (
          <p className={cn("m-0 mt-0.5 text-muted-foreground", compact ? "line-clamp-2" : "whitespace-pre-wrap")}>{view.body}</p>
        ) : null}
      </div>
    </li>
  );
}

function StatusChip({ status }: { status: keyof typeof REQUIREMENT_STATUS_LABELS }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-xs bg-muted px-1.5 py-px text-caption text-foreground">
      <StatusIcon status={status} aria-hidden="true" className="size-3" />
      {REQUIREMENT_STATUS_LABELS[status]}
    </span>
  );
}

function EntrySkeleton() {
  return (
    <div className="flex gap-2.5" aria-hidden="true">
      <Skeleton className="size-5 rounded-full" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-3/5" />
        <Skeleton className="h-3 w-16" />
      </div>
    </div>
  );
}
