import { type RequirementListItemDto } from "@suduo/client-contracts";
import { MessageSquareIcon, PaperclipIcon, TerminalIcon } from "lucide-react";
import { useId, type ComponentProps } from "react";
import { PriorityIcon } from "@/components/ui/priority-icon";
import { cn } from "@/lib/utils";
import { requirementCode, summaryPreview } from "../format.js";
import { useRecentlyChanged } from "../highlight.js";
import { UserAvatar } from "./UserAvatar.js";
import { formatDateTime, formatRelativeTime } from "../../../ui/format.js";
import { requirementPriorityLabel } from "../../../ui/requirement-priority.js";
import { requirementStatusLabel } from "../../../ui/requirement-status.js";
import { useT } from "../../../i18n/provider.js";

/**
 * 看板卡片（原型 Main · 看板）：优先级、编号、负责人、标题（两行）、描述（一行）、材料 / 评论 / 本机会话计数与更新时间。
 * 无优先级（或旧版需求服务不给）时不显示优先级图标。
 * 整张卡是一个按钮：点击或 Enter 打开速览；选中时强调描边；他人刚改过时底色闪一下。
 */
export function RequirementCard({
  requirement,
  selected = false,
  dragging = false,
  overlay = false,
  className,
  ...props
}: {
  requirement: RequirementListItemDto;
  selected?: boolean;
  /** 原位占位（正在被拖走）。 */
  dragging?: boolean;
  /** 跟随指针的拖拽影像。 */
  overlay?: boolean;
} & ComponentProps<"button">) {
  const t = useT();
  const changed = useRecentlyChanged(requirement.id);
  const descriptionId = useId();
  const summary = summaryPreview(requirement.summary);
  const code = requirementCode(requirement.number);
  const assigneeName = requirement.assignee?.displayName ?? t.requirements.assignee.unassigned;
  return (
    <button
      type="button"
      data-requirement-id={requirement.id}
      data-requirement-number={requirement.number}
      data-testid="requirement-card"
      aria-label={`${code} ${requirement.title}`}
      aria-describedby={descriptionId}
      aria-current={selected === true ? "true" : undefined}
      className={cn(
        "group/card flex w-full cursor-pointer flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2.5 text-left shadow-1 outline-none",
        "transition-[border-color,box-shadow] duration-100 hover:border-border-strong",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selected && "border-primary shadow-[0_0_0_1px_var(--primary)] hover:border-primary",
        changed && "animate-flash",
        dragging && "opacity-40",
        overlay && "rotate-1 cursor-grabbing shadow-3",
        className,
      )}
      {...props}
    >
      <span id={descriptionId} className="sr-only">
        {t.requirements.card.description(
          requirementStatusLabel(requirement.status, t),
          assigneeName,
          requirement.priority == null ? null : requirementPriorityLabel(requirement.priority, t),
        )}
      </span>
      <span className="flex w-full items-center gap-2">
        {requirement.priority == null ? null : (
          <span className="inline-flex" title={requirementPriorityLabel(requirement.priority, t)}>
            <PriorityIcon priority={requirement.priority} aria-hidden="true" data-testid="requirement-card-priority" />
          </span>
        )}
        <span className="font-mono text-caption text-subtle-foreground">{code}</span>
        <span className="ml-auto" title={assigneeName}>
          <UserAvatar user={requirement.assignee} />
        </span>
      </span>
      <span className="line-clamp-2 text-body font-medium text-foreground">{requirement.title}</span>
      {summary === "" ? null : (
        <span className="line-clamp-1 w-full text-caption text-muted-foreground">{summary}</span>
      )}
      <span className="mt-0.5 flex w-full items-center gap-2.5 text-caption text-subtle-foreground">
        {requirement.attachmentCount > 0 ? (
          <span className="inline-flex items-center gap-0.5" title={t.requirements.card.attachments(requirement.attachmentCount)}>
            <PaperclipIcon className="size-3.5" aria-hidden="true" />
            {requirement.attachmentCount}
          </span>
        ) : null}
        {requirement.commentCount > 0 ? (
          <span className="inline-flex items-center gap-0.5" title={t.requirements.card.comments(requirement.commentCount)}>
            <MessageSquareIcon className="size-3.5" aria-hidden="true" />
            {requirement.commentCount}
          </span>
        ) : null}
        {requirement.localSessionCount > 0 ? (
          <span className="inline-flex items-center gap-0.5" title={t.requirements.card.localSessions(requirement.localSessionCount)}>
            <TerminalIcon className="size-3.5" aria-hidden="true" />
            {requirement.localSessionCount}
          </span>
        ) : null}
        <time className="ml-auto" dateTime={requirement.updatedAt} title={formatDateTime(requirement.updatedAt)}>
          {formatRelativeTime(requirement.updatedAt)}
        </time>
      </span>
    </button>
  );
}
