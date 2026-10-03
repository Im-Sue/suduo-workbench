import type { AuditEntryDto } from "@suduo/cloud-contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatTime, relativeTime } from "../../ui/format.js";
import { groupOverviewAudit, groupSummary, presentAudit, statusTransitionOf, type AuditTone } from "./timeline.js";

const TONE_DOT: Record<AuditTone, string> = {
  created: "bg-success",
  updated: "bg-primary",
  deleted: "bg-danger",
  neutral: "bg-subtle-foreground",
};

/**
 * 最近动态：同一人相邻的同类操作归成一组，可展开；状态流转单独一行并写明前后状态。
 * 限高（需求 §4.6）：先显示最近 preview 组，其余点「显示全部」。
 */
export function OverviewTimeline({ entries, preview = 8 }: { entries: readonly AuditEntryDto[]; preview?: number }) {
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const allGroups = groupOverviewAudit(entries);
  const groups = showAll ? allGroups : allGroups.slice(0, preview);

  if (allGroups.length === 0) {
    return <p className="m-0 py-3 text-small text-muted-foreground">这个项目还没有动态。</p>;
  }

  const toggle = (groupId: string) =>
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });

  return (
    <div className="flex flex-col gap-1">
      <ol className="m-0 flex list-none flex-col p-0" data-testid="overview-timeline">
        {groups.map((group) => {
          const groupId = group.entries[0]!.id;
          if (group.entries.length === 1) return <TimelineEntry key={groupId} entry={group.entries[0]!} />;
          const expanded = expandedGroups.has(groupId);
          return (
            <li key={groupId} className="flex flex-col">
              <button
                type="button"
                className="flex items-start gap-2.5 rounded-md px-1.5 py-1.5 text-left text-small outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={expanded}
                onClick={() => toggle(groupId)}
              >
                <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", TONE_DOT[presentAudit(group.entries[0]!).tone])} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">{group.actorName}</span>{" "}
                  <span className="text-muted-foreground">{groupSummary(group.action, group.entries.length)}</span>
                </span>
                <Time iso={group.createdAt} />
                <ChevronRightIcon className={cn("mt-0.5 size-3.5 shrink-0 text-subtle-foreground transition-transform", expanded && "rotate-90")} aria-hidden="true" />
              </button>
              {expanded ? (
                <ol className="m-0 ml-3 flex list-none flex-col border-l border-border p-0 pl-1.5">
                  {group.entries.map((entry) => (
                    <TimelineEntry key={entry.id} entry={entry} />
                  ))}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ol>
      {allGroups.length > preview ? (
        <button
          type="button"
          className="self-start rounded-md px-1.5 py-1 text-small font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "收起" : `显示全部 ${entries.length} 条`}
        </button>
      ) : null}
    </div>
  );
}

function TimelineEntry({ entry }: { entry: AuditEntryDto }) {
  const presented = presentAudit(entry);
  const transition = statusTransitionOf(entry);
  return (
    <li data-testid={`overview-audit-${entry.action}`} className="flex items-start gap-2.5 px-1.5 py-1.5 text-small">
      <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", TONE_DOT[presented.tone])} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground">{entry.actor.displayName}</span>{" "}
        <span className="text-muted-foreground">{presented.text}</span>
        {transition === null ? null : <span className="ml-1 font-medium text-foreground">{transition}</span>}
      </span>
      <Time iso={entry.createdAt} />
    </li>
  );
}

function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} className="shrink-0 text-caption text-subtle-foreground" title={formatTime(Date.parse(iso))}>
      {relativeTime(Date.parse(iso))}
    </time>
  );
}
