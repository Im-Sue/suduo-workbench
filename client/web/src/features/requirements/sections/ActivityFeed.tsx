import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  type RequirementActivityEntryDto,
} from "@suduo/cloud-contracts";
import { ArrowRightIcon, PaperclipIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../../api/client.js";
import { reportFailure } from "../../../feedback/report.js";
import { showMessage } from "../../../ui/message.js";
import { FileGallery, type DisplayFile } from "../../rooms/components/RoomFile.js";
import { requirementKeys } from "../keys.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { RegionError } from "../../../feedback/components/index.js";
import { useT } from "../../../i18n/provider.js";
import { Markdown } from "../../../ui/markdown.js";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusIcon } from "@/components/ui/status-icon";
import { cn } from "@/lib/utils";
import { presentActivity, type ActivityKind } from "../activity.js";
import { activityQuery } from "../queries.js";
import { UserAvatar } from "../components/UserAvatar.js";
import { formatDateTime, formatRelativeTime } from "../../../ui/format.js";
import { requirementStatusLabel } from "../../../ui/requirement-status.js";
import type { RequirementStatus } from "@suduo/cloud-contracts";

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
  const t = useT();
  const text = t.requirementDetail.activity;
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
        message={text.loadFailed(failure.message)}
        busy={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <ol className={cn("m-0 flex list-none flex-col p-0", mode === "recent" ? "gap-2.5" : "gap-4")} aria-label={text.listLabel}>
      {mode === "timeline" && query.hasNextPage ? (
        <li>
          <Button variant="ghost" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {text.loadEarlier}
          </Button>
        </li>
      ) : null}
      {entries.length === 0 ? (
        <li className="text-caption text-subtle-foreground">
          {query.hasNextPage ? text.emptyRecent[filter](mode === "timeline") : text.empty[filter]}
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
  const t = useT();
  const view = presentActivity(entry, t);
  const time = (
    <time className="text-caption text-subtle-foreground" dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>
      {formatRelativeTime(entry.createdAt)}
    </time>
  );
  const files = entry.comment?.files ?? [];
  if (view.kind === "comment" && !compact) {
    return (
      <li className="flex gap-2.5" data-testid="activity-comment">
        <UserAvatar user={entry.actor} size="lg" className="mt-0.5" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline gap-1.5 text-small">
            <strong className="font-semibold">{entry.actor.displayName}</strong>
            {time}
          </div>
          {/* 只带文件、没写文字的评论不留空白气泡（需求附件评论文件与优先级 4.2）。 */}
          {(view.body ?? "") === "" && files.length > 0 ? null : (
            <div className="rounded-md border border-border bg-card px-3 py-2 text-body">
              <Markdown text={view.body ?? ""} />
            </div>
          )}
          {files.length === 0 ? null : (
            <div data-testid="comment-files">
              <FileGallery
                files={files}
                urlFor={api.commentFileUrl}
                previewDocuments
                actions={(file) => <SaveAsAttachment requirementId={entry.requirementId} file={file} />}
              />
            </div>
          )}
        </div>
      </li>
    );
  }
  const compactBody = view.kind === "comment" && (view.body ?? "") === "" && files.length > 0
    ? t.requirementDetail.comments.filesOnly(files.length)
    : view.body;
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
              {t.requirementDetail.activity.statusChanged}
              <StatusChip status={view.status.from} />
              <ArrowRightIcon className="size-3" aria-label={t.requirementDetail.activity.statusArrow} />
              <StatusChip status={view.status.to} />
            </span>
          )}
          {compact ? null : <> · {time}</>}
        </span>
        {compact ? time : null}
        {compactBody !== null && (compact || view.kind !== "comment") ? (
          <p className={cn("m-0 mt-0.5 text-muted-foreground", compact ? "line-clamp-2" : "whitespace-pre-wrap")}>{compactBody}</p>
        ) : null}
      </div>
    </li>
  );
}

/** 评论文件的「存为附件」：复制一份到附件区（上传人记为自己），原评论不变；可以重复存。 */
function SaveAsAttachment({ requirementId, file }: { requirementId: string; file: DisplayFile }) {
  const text = useT().requirementDetail.comments;
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.saveCommentFileAsAttachment(file.id);
      showMessage(text.savedAsAttachment(file.fileName), "success");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: requirementKeys.attachments(requirementId) }),
        queryClient.invalidateQueries({ queryKey: requirementKeys.activity(requirementId) }),
        queryClient.invalidateQueries({ queryKey: requirementKeys.detail(requirementId) }),
      ]);
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.saveAsAttachmentFailed(file.fileName), retry: () => void save() });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 px-2 text-caption"
      loading={saving}
      aria-label={text.saveAsAttachmentLabel(file.fileName)}
      title={text.saveAsAttachmentLabel(file.fileName)}
      onClick={() => void save()}
    >
      <PaperclipIcon className="size-3.5" />
      {text.saveAsAttachment}
    </Button>
  );
}

function StatusChip({ status }: { status: RequirementStatus }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1 rounded-xs bg-muted px-1.5 py-px text-caption text-foreground">
      <StatusIcon status={status} aria-hidden="true" className="size-3" />
      {requirementStatusLabel(status, t)}
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
