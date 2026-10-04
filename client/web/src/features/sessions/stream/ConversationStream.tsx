import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { TimelineEntry, TimelineNotice } from "../../../event-projection/timeline.js";
import { useCarried, useCarrySource, useT } from "../../../i18n/provider.js";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { TurnView, type TurnViewActions } from "./TurnView.js";
import { UserBubble } from "./UserBubble.js";

/**
 * 会话消息流（需求 §4.5）：按时间线渲染，内容最宽 760px 居中。
 * - 贴底跟随：在底部时新内容自动滚入；往上翻时不打扰，出现「有新内容」；
 * - 长会话（条目多于阈值）用虚拟列表，只渲染可见附近的条目；短会话整段渲染，避免测量抖动。
 */
const VIRTUALIZE_AFTER = 80;
const NEAR_BOTTOM_PX = 96;

export function ConversationStream({
  timeline,
  historyLoading,
  turnSlots,
  now,
  actions,
  empty,
  scrollCarryKey = null,
}: {
  timeline: TimelineEntry[];
  historyLoading: boolean;
  turnSlots?: ReadonlyMap<string, ReactNode>;
  now: number;
  actions: TurnViewActions;
  empty: ReactNode;
  /**
   * 切换语言时带过重建的滚动位置用的 key（i18n/carry.ts）。会话页与房间里的执行过程可能同时挂着，
   * 由调用方给出区分对象的 key（会话 id / 执行 id）；不给就不带。
   */
  scrollCarryKey?: string | null;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // 读到一半往上翻着时切换语言（别的标签页改的）：重建后回到原来的位置，不跳到底部（i18n/carry.ts）。
  const carriedScroll = useCarried<{ atBottom: boolean; top: number }>(scrollCarryKey);
  const atBottom = useRef(carriedScroll?.atBottom ?? true);
  useCarrySource(scrollCarryKey, () => ({ atBottom: atBottom.current, top: scrollRef.current?.scrollTop ?? 0 }));
  useLayoutEffect(() => {
    if (carriedScroll === undefined || carriedScroll.atBottom || scrollRef.current === null) return;
    scrollRef.current.scrollTop = carriedScroll.top;
    // 只在挂载时回到原位；之后照常由滚动决定贴不贴底。
  }, []);
  const [showPill, setShowPill] = useState(false);
  const virtual = timeline.length > VIRTUALIZE_AFTER;

  const virtualizer = useVirtualizer({
    count: virtual ? timeline.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (timeline[index]?.kind === "turn" ? 240 : 72),
    getItemKey: (index) => timeline[index]?.id ?? index,
    overscan: 6,
  });

  const stickToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  // 内容变化（新条目、流式文字变长、步骤展开）时，在底部就继续贴底。
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (content === null || typeof ResizeObserver === "undefined") return undefined;
    // 只负责贴底；「有新内容」只看时间线本身有没有变化（自己展开步骤不算）。
    const observer = new ResizeObserver(() => {
      if (atBottom.current) stickToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [stickToBottom]);

  useLayoutEffect(() => {
    if (atBottom.current) {
      if (virtual && timeline.length > 0) virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
      stickToBottom();
    }
  }, [timeline, virtual, virtualizer, stickToBottom]);

  // 「有新内容」只看内容指纹（条目数、最后一条的块数与文字量），不看数组引用：重渲染不等于有新内容。
  const fingerprint = timelineFingerprint(timeline);
  const seenFingerprint = useRef(fingerprint);
  useEffect(() => {
    if (seenFingerprint.current === fingerprint) return;
    seenFingerprint.current = fingerprint;
    setShowPill(!atBottom.current);
  }, [fingerprint]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (element === null) return;
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    if (atBottom.current) setShowPill(false);
  };

  const renderEntry = (entry: TimelineEntry) => {
    switch (entry.kind) {
      case "user":
        return <UserBubble message={entry.message} />;
      case "turn":
        return (
          <TurnView
            turn={entry.turn}
            slot={entry.turn.turnId === null ? undefined : turnSlots?.get(entry.turn.turnId)}
            now={now}
            actions={actions}
          />
        );
      case "notice":
        return <NoticeRow notice={entry.notice} />;
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        data-testid="conversation-stream"
      >
        <div ref={contentRef} className="mx-auto w-full max-w-[808px] px-6 pt-6 pb-4">
          {historyLoading ? (
            <p className="m-0 mb-4 flex items-center justify-center gap-2 text-caption text-subtle-foreground" role="status">
              <Spinner size="sm" />
              {t.conversation.stream.loadingHistory}
            </p>
          ) : null}
          {timeline.length === 0 && !historyLoading ? empty : null}
          {virtual ? (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const entry = timeline[item.index];
                if (entry === undefined) return null;
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 w-full pb-6"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {renderEntry(entry)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {timeline.map((entry) => (
                <div key={entry.id}>{renderEntry(entry)}</div>
              ))}
            </div>
          )}
        </div>
      </div>
      {showPill ? (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-popover px-3 text-caption font-medium text-foreground shadow-2 outline-none hover:bg-popover-hover focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            atBottom.current = true;
            if (virtual && timeline.length > 0) virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
            stickToBottom();
            setShowPill(false);
          }}
        >
          <ArrowDownIcon className="size-3.5" aria-hidden="true" />
          {t.conversation.stream.newContent}
        </button>
      ) : null}
    </div>
  );
}

function NoticeRow({ notice }: { notice: TimelineNotice }) {
  const Icon = notice.level === "info" ? InfoIcon : TriangleAlertIcon;
  return (
    <p
      className={cn(
        "m-0 flex items-start gap-2 rounded-md px-3 py-2 text-small",
        notice.level === "error" ? "bg-danger-soft text-foreground" : notice.level === "important" ? "bg-warning-soft text-foreground" : "text-muted-foreground",
      )}
      role={notice.level === "error" ? "alert" : "status"}
      data-testid="stream-notice"
      data-level={notice.level}
    >
      <Icon
        className={cn("mt-0.5 size-3.5 shrink-0", notice.level === "error" ? "text-danger" : notice.level === "important" ? "text-warning" : "text-subtle-foreground")}
        aria-hidden="true"
      />
      <span className="min-w-0 break-words">{notice.text}</span>
    </p>
  );
}

function timelineFingerprint(timeline: readonly TimelineEntry[]): string {
  const last = timeline.at(-1);
  if (last === undefined) return "0";
  if (last.kind !== "turn") return `${timeline.length}:${last.id}`;
  let size = 0;
  for (const block of last.turn.blocks) {
    size += block.kind === "text" ? block.text.length : block.kind === "steps" ? block.steps.length * 1000 + block.steps.reduce((sum, step) => sum + step.output.length, 0) : 1;
  }
  return `${timeline.length}:${last.id}:${last.turn.blocks.length}:${size}:${last.turn.status}:${last.turn.error?.message ?? ""}`;
}
