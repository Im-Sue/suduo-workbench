import { useVirtualizer } from "@tanstack/react-virtual";
import type { AgentRunSummaryDto, RoomMessageDto } from "@suduo/cloud-contracts";
import { ArrowDownIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { maxSeq, rootMessages, type MessagesData } from "../model.js";
import type { PendingRoomMessage } from "../pending.js";
import { DaySeparator, MessageItem, PendingMessageItem } from "./MessageItem.js";
import { dayKey, formatDayLabel } from "../../../ui/format.js";

/**
 * 房间消息流（需求十一）：按日期分隔；同一人连续发的消息合并头像；向上滚到顶加载更早（滚动位置不跳）；
 * 在底部时新消息自动滚入，往上翻着时出现「有新消息」；消息多时用虚拟列表，只渲染可见附近的条目。
 */
const VIRTUALIZE_AFTER = 120;
const NEAR_BOTTOM_PX = 80;
const LOAD_OLDER_PX = 160;
const COMPACT_WITHIN_MS = 5 * 60_000;

type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: RoomMessageDto; compact: boolean }
  | { kind: "pending"; key: string; pending: PendingRoomMessage };

function buildRows(messages: readonly RoomMessageDto[], pending: readonly PendingRoomMessage[], now: Date): Row[] {
  const rows: Row[] = [];
  let lastDay = "";
  let previous: RoomMessageDto | null = null;
  for (const message of messages) {
    const day = dayKey(message.createdAt);
    if (day !== lastDay) {
      rows.push({ kind: "day", key: `day-${day}`, label: formatDayLabel(message.createdAt, now) });
      lastDay = day;
      previous = null;
    }
    const compact =
      previous !== null &&
      previous.authorKind === message.authorKind &&
      message.authorKind !== "system" &&
      (previous.author?.id ?? null) === (message.author?.id ?? null) &&
      (previous.agent?.id ?? null) === (message.agent?.id ?? null) &&
      Date.parse(message.createdAt) - Date.parse(previous.createdAt) < COMPACT_WITHIN_MS &&
      (previous.thread?.replyCount ?? 0) === 0 &&
      previous.runs.length === 0;
    rows.push({ kind: "message", key: message.id, message, compact });
    previous = message;
  }
  for (const item of pending) rows.push({ kind: "pending", key: `pending-${item.clientId}`, pending: item });
  return rows;
}

export function MessageStream({
  data,
  pending,
  meId,
  loadingOlder,
  onLoadOlder,
  onOpenThread,
  onOpenRun,
  onViewState,
  empty,
}: {
  data: MessagesData;
  pending: readonly PendingRoomMessage[];
  meId: string | null;
  loadingOlder: boolean;
  onLoadOlder(): void;
  onOpenThread(rootId: string): void;
  onOpenRun(run: AgentRunSummaryDto): void;
  /** 滚动 / 内容变化时回报「是否在底部、看到的最大序号」，用来记已读。 */
  onViewState(state: { atBottom: boolean; maxSeq: number }): void;
  empty: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showPill, setShowPill] = useState(false);
  const roots = useMemo(() => rootMessages(data.items), [data.items]);
  const rows = useMemo(() => buildRows(roots, pending, new Date()), [roots, pending]);
  const virtual = rows.length > VIRTUALIZE_AFTER;
  const seen = maxSeq(data.items);

  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === "day" ? 36 : 72),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 8,
  });

  const report = useCallback(() => {
    onViewState({ atBottom: atBottom.current, maxSeq: seen });
  }, [onViewState, seen]);

  const stickToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  // 内容尺寸变化（图片加载、展开）时，在底部就继续贴底。
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (content === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) stickToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [stickToBottom]);

  // 行变化：向上翻历史 → 保持视线位置；在底部 → 贴底；不在底部又来了新消息 → 「有新消息」。
  const previousRows = useRef<{ first: string | null; last: string | null; pending: number }>({ first: null, last: null, pending: 0 });
  const anchor = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const first = rows[0]?.key ?? null;
    const last = rows.at(-1)?.key ?? null;
    const pendingCount = pending.length;
    const before = previousRows.current;
    previousRows.current = { first, last, pending: pendingCount };
    if (element === null) return;
    if (anchor.current !== null && first !== before.first) {
      // 更早的消息插在上面：按「离底部的距离」还原，视线停在原来那条上。
      element.scrollTop = element.scrollHeight - anchor.current;
      anchor.current = null;
      return;
    }
    if (pendingCount > before.pending) atBottom.current = true; // 自己刚发：回到底部
    if (atBottom.current) {
      if (virtual && rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
      stickToBottom();
      setShowPill(false);
    } else if (last !== before.last && before.last !== null) {
      setShowPill(true);
    }
  }, [rows, pending.length, virtual, virtualizer, stickToBottom]);

  useEffect(() => {
    report();
  }, [report]);

  const loadOlder = () => {
    const element = scrollRef.current;
    if (element === null || loadingOlder || !data.hasMoreBefore) return;
    anchor.current = element.scrollHeight - element.scrollTop;
    onLoadOlder();
  };

  const onScroll = () => {
    const element = scrollRef.current;
    if (element === null) return;
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    if (atBottom.current) setShowPill(false);
    if (element.scrollTop < LOAD_OLDER_PX && data.hasMoreBefore && !loadingOlder) loadOlder();
    report();
  };

  const renderRow = (row: Row) => {
    switch (row.kind) {
      case "day":
        return <DaySeparator label={row.label} />;
      case "message":
        return (
          <MessageItem
            message={row.message}
            compact={row.compact}
            meId={meId}
            variant="stream"
            onOpenThread={onOpenThread}
            onOpenRun={onOpenRun}
          />
        );
      case "pending":
        return <PendingMessageItem pending={row.pending} />;
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        role="log"
        aria-label="消息记录"
        data-testid="room-message-stream"
      >
        <div ref={contentRef} className="flex min-h-full flex-col justify-end pt-3 pb-2">
          {data.hasMoreBefore ? (
            <div className="flex justify-center py-2">
              <Button size="sm" variant="ghost" loading={loadingOlder} onClick={loadOlder} data-testid="room-load-older">
                更早的消息 · 加载更多
              </Button>
            </div>
          ) : roots.length > 0 ? (
            <p className="m-0 py-3 text-center text-caption text-subtle-foreground">这是讨论的开始</p>
          ) : null}
          {rows.length === 0 ? empty : null}
          {virtual ? (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (row === undefined) return null;
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {renderRow(row)}
                  </div>
                );
              })}
            </div>
          ) : (
            rows.map((row) => <div key={row.key}>{renderRow(row)}</div>)
          )}
        </div>
      </div>
      {showPill ? (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-popover px-3 text-caption font-medium text-foreground shadow-2 outline-none hover:bg-popover-hover focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="room-new-messages"
          onClick={() => {
            atBottom.current = true;
            if (virtual && rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
            stickToBottom();
            setShowPill(false);
            report();
          }}
        >
          <ArrowDownIcon className="size-3.5" aria-hidden="true" />
          有新消息
        </button>
      ) : null}
    </div>
  );
}
