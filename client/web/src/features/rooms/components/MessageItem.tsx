import type { AgentRunSummaryDto, RoomMessageDto, UserSummaryDto } from "@suduo/cloud-contracts";
import { BotIcon, ChevronRightIcon, MessageSquareReplyIcon } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { avatarTone } from "@/components/ui/avatar";
import { Markdown } from "../../../ui/markdown.js";
import { UserAvatar } from "../../requirements/components/UserAvatar.js";
import { agentName, mentionHighlights } from "../model.js";
import type { PendingRoomMessage } from "../pending.js";
import { RoomFiles } from "./RoomFile.js";
import { RunCard, RunStatusLine } from "./RunStatusLine.js";
import { formatClock, formatDateTime, formatRelativeTime } from "../../../ui/format.js";

/**
 * 一条房间消息（需求 4.3 / 十一）：头像 + 名字 + 时间；Agent 消息显示「<所有者> 的 Codex」与 Agent 标识；
 * Markdown 正文（@ 高亮）、文件、被 @ 的 Agent 状态行、「N 条回复 ›」与最近回复者。
 * variant=stream 用在主消息流；thread 用在话题面板（状态行换成状态卡，不显示回复入口）。
 */
export function AgentAvatar({ owner, size = "lg" }: { owner: UserSummaryDto; size?: "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full text-white",
        size === "lg" ? "size-7" : "size-5",
      )}
      style={{ backgroundColor: avatarTone(owner.displayName) }}
    >
      <BotIcon className={size === "lg" ? "size-4" : "size-3"} />
    </span>
  );
}

export const MessageItem = memo(function MessageItem({
  message,
  compact,
  meId,
  variant,
  onOpenThread,
  onOpenRun,
}: {
  message: RoomMessageDto;
  /** 与上一条同一作者、相隔很近：省掉头像和名字。 */
  compact: boolean;
  meId: string | null;
  variant: "stream" | "thread";
  onOpenThread(rootId: string): void;
  onOpenRun(run: AgentRunSummaryDto): void;
}) {
  const highlights = useMemo(() => mentionHighlights(message.mentions), [message.mentions]);
  if (message.authorKind === "system") {
    return (
      <div className="px-5 py-1.5 text-center text-caption text-subtle-foreground" data-testid="room-message" data-message-id={message.id} data-seq={message.seq} data-kind="system">
        {message.body}
      </div>
    );
  }
  const name = message.agent === null ? (message.author?.displayName ?? "有人") : agentName(message.agent);
  const time = formatClock(message.createdAt);
  const thread = message.thread;
  return (
    <article
      className={cn("group/msg relative flex gap-3 px-5 hover:bg-muted/50 focus-within:bg-muted/50", compact ? "py-0.5" : "pt-2 pb-1")}
      aria-label={`${name}，${time}`}
      data-testid="room-message"
      data-message-id={message.id}
      data-seq={message.seq}
      data-kind={message.authorKind}
    >
      <div className="w-7 shrink-0 pt-0.5">
        {compact ? null : message.agent !== null ? <AgentAvatar owner={message.agent.owner} /> : <UserAvatar user={message.author} size="lg" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {compact ? null : (
          <header className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-small font-semibold text-foreground">{name}</span>
            {message.agent === null ? null : <Badge variant="primary" className="h-4 px-1">Agent</Badge>}
            <time className="shrink-0 text-caption text-subtle-foreground" dateTime={message.createdAt} title={formatDateTime(message.createdAt)}>
              {time}
            </time>
          </header>
        )}
        {message.body.trim() === "" ? null : (
          <div className="text-body text-foreground">
            <Markdown text={message.body} highlights={highlights} />
          </div>
        )}
        <RoomFiles files={message.files} />
        {variant === "stream"
          ? message.runs.map((run) => <RunStatusLine key={run.id} run={run} meId={meId} onOpen={() => onOpenThread(run.threadRootId)} />)
          : message.runs.length === 0
            ? null
            : (
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {message.runs.map((run) => (
                    <RunCard key={run.id} run={run} meId={meId} onViewDetail={() => onOpenRun(run)} />
                  ))}
                </div>
              )}
        {variant === "stream" && thread !== null && thread.replyCount > 0 ? (
          <ThreadSummary
            count={thread.replyCount}
            lastReplyAt={thread.lastReplyAt}
            repliers={thread.lastRepliers}
            onOpen={() => onOpenThread(message.id)}
          />
        ) : null}
      </div>
      {variant === "stream" ? (
        <div className="absolute top-1 right-4 opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-sm border border-border bg-popover px-2 text-caption text-muted-foreground shadow-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`回复 ${name} 的消息`}
            onClick={() => onOpenThread(message.id)}
          >
            <MessageSquareReplyIcon className="size-3.5" aria-hidden="true" />
            回复
          </button>
        </div>
      ) : null}
    </article>
  );
});

function ThreadSummary({
  count,
  lastReplyAt,
  repliers,
  onOpen,
}: {
  count: number;
  lastReplyAt: string | null;
  repliers: readonly UserSummaryDto[];
  onOpen(): void;
}) {
  return (
    <button
      type="button"
      className="mt-1 inline-flex h-7 max-w-full items-center gap-2 self-start rounded-sm px-1.5 text-caption outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
      data-testid="thread-summary"
    >
      <span className="flex -space-x-1" aria-hidden="true">
        {repliers.slice(0, 3).map((user) => (
          <UserAvatar key={user.id} user={user} size="md" className="ring-2 ring-card" />
        ))}
      </span>
      <span className="font-medium text-primary-text">{count} 条回复</span>
      {lastReplyAt === null ? null : (
        <span className="truncate text-subtle-foreground">最后回复 {formatRelativeTime(lastReplyAt)}</span>
      )}
      <ChevronRightIcon className="size-3 shrink-0 text-subtle-foreground" aria-hidden="true" />
    </button>
  );
}

/** 发送中的占位：先本地显示（灰），服务端返回后被正式消息替换。 */
export function PendingMessageItem({ pending }: { pending: PendingRoomMessage }) {
  return (
    <article
      className="flex gap-3 px-5 pt-2 pb-1 opacity-60"
      aria-busy="true"
      aria-label={`${pending.author?.displayName ?? "我"}，发送中`}
      data-testid="room-message-pending"
      data-client-id={pending.clientId}
    >
      <div className="w-7 shrink-0 pt-0.5">
        <UserAvatar user={pending.author} size="lg" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-baseline gap-2">
          <span className="text-small font-semibold text-foreground">{pending.author?.displayName ?? "我"}</span>
          <span className="inline-flex items-center gap-1 text-caption text-subtle-foreground">
            <Spinner size="sm" />
            发送中…
          </span>
        </header>
        {pending.body === "" ? null : <div className="text-body whitespace-pre-wrap text-foreground">{pending.body}</div>}
        {pending.files.length === 0 ? null : (
          <p className="m-0 mt-1 text-caption text-subtle-foreground">附带 {pending.files.length} 个文件</p>
        )}
      </div>
    </article>
  );
}

export function DaySeparator({ label }: { label: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-5 py-2" role="separator" aria-label={typeof label === "string" ? label : undefined}>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span className="text-caption font-medium text-subtle-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
