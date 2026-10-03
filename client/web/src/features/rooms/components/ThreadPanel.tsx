import { useQueryClient } from "@tanstack/react-query";
import type { AgentRunSummaryDto, RoomDto, RoomMessageDto } from "@suduo/cloud-contracts";
import { XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { classifyFailure } from "../../../feedback/classify.js";
import { RegionError } from "../../../feedback/components/index.js";
import { roomKeys } from "../keys.js";
import type { MessagesData } from "../model.js";
import { hidePending, usePendingMessages } from "../pending.js";
import { useThreadMessages } from "../queries.js";
import { AgentRunDetail } from "./AgentRunDetail.js";
import { MessageItem, PendingMessageItem } from "./MessageItem.js";
import { RoomComposer } from "./RoomComposer.js";

/**
 * 右侧话题面板（需求 4.7 第二层，参照 Tutti 的话题面板）：
 * 原消息 → 每个任务一张状态卡（状态、用时、「查看详情」）→ 回复（含 Agent 的完整回答）→ 底部「回复话题」。
 * 回复先取最新一页，更早的点「加载更早的回复」往前翻（视线停在原来那条上）；原消息始终显示在最上面。
 * 「查看详情」在面板里换成运行详情（完整执行过程），可以返回话题。
 */
export function ThreadPanel({
  room,
  rootId,
  runId,
  meId,
  onClose,
  onOpenRun,
  onCloseRun,
}: {
  room: RoomDto;
  rootId: string;
  runId: string | null;
  meId: string | null;
  onClose(): void;
  onOpenRun(run: AgentRunSummaryDto): void;
  onCloseRun(): void;
}) {
  const queryClient = useQueryClient();
  const thread = useThreadMessages(room.id, rootId);
  const pending = usePendingMessages(room.id, rootId);
  // 话题还没取回来时，先用主消息流里的根消息顶上（不闪空白）。
  const cachedRoot = useMemo(
    () => queryClient.getQueryData<MessagesData>(roomKeys.messages(room.id))?.items.find((item) => item.id === rootId),
    [queryClient, room.id, rootId],
  );
  const items = thread.data?.items ?? [];
  const root: RoomMessageDto | undefined = items.find((item) => item.id === rootId) ?? cachedRoot;
  const replies = items.filter((item) => item.threadRootId === rootId);
  const shownPending = hidePending(pending, items);
  const hasOlder = thread.data?.hasMoreBefore === true;
  // 只取了一部分回复时，条数以根上的话题计数为准。
  const replyCount = Math.max(replies.length, root?.thread?.replyCount ?? 0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const lastKey = `${replies.at(-1)?.id ?? ""}:${shownPending.length}`;
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [lastKey]);

  // 更早的回复插在上面：按「离底部的距离」还原，视线停在原来那条上（同主消息流）。
  const anchor = useRef<number | null>(null);
  const firstReplyId = replies[0]?.id ?? null;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null || anchor.current === null) return;
    element.scrollTop = element.scrollHeight - anchor.current;
    anchor.current = null;
  }, [firstReplyId]);
  const loadOlder = () => {
    const element = scrollRef.current;
    if (element !== null) anchor.current = element.scrollHeight - element.scrollTop;
    void thread.loadOlder();
  };

  return (
    <section
      className="flex h-full min-h-0 w-full flex-col bg-card"
      aria-label="话题"
      data-testid="thread-panel"
      data-root-id={rootId}
    >
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <h2 className="m-0 flex-1 text-body font-semibold text-foreground">{runId === null ? "话题" : "执行过程"}</h2>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-sm text-subtle-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="关闭话题"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {runId !== null ? (
        <div className="min-h-0 flex-1">
          <AgentRunDetail key={runId} runId={runId} onBack={onCloseRun} />
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-2" data-testid="thread-messages">
            {thread.isPending && root === undefined ? (
              <div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label="正在加载话题">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : null}
            {thread.isError && root === undefined ? (
              <RegionError
                kind={classifyFailure(thread.error).kind}
                message={`查不到这个话题：${classifyFailure(thread.error).message}`}
                busy={thread.isFetching}
                onRetry={() => void thread.refetch()}
              />
            ) : null}
            {root === undefined ? null : (
              <MessageItem message={root} compact={false} meId={meId} variant="thread" onOpenThread={() => undefined} onOpenRun={onOpenRun} />
            )}
            {root === undefined ? null : (
              <div className="flex items-center gap-3 px-5 py-2" aria-hidden="true">
                <span className="text-caption text-subtle-foreground">
                  {replyCount === 0 ? "还没有回复" : `${replyCount} 条回复`}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            {thread.isError && root !== undefined ? (
              <p className="m-0 px-5 py-1 text-caption text-danger" role="alert">
                查不到这个话题的回复：{classifyFailure(thread.error).message}
              </p>
            ) : null}
            {hasOlder ? (
              <div className="flex justify-center py-1">
                <Button size="sm" variant="ghost" loading={thread.loadingOlder} onClick={loadOlder} data-testid="thread-load-older">
                  加载更早的回复
                </Button>
              </div>
            ) : null}
            {replies.map((reply) => (
              <MessageItem key={reply.id} message={reply} compact={false} meId={meId} variant="thread" onOpenThread={() => undefined} onOpenRun={onOpenRun} />
            ))}
            {shownPending.map((item) => (
              <PendingMessageItem key={item.clientId} pending={item} />
            ))}
          </div>
          <div className="shrink-0 border-t border-border px-3 pt-2 pb-3">
            <RoomComposer room={room} threadRootId={rootId} placeholder="回复话题，@ 可以继续问 Agent" />
          </div>
        </>
      )}
    </section>
  );
}
