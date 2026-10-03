import { useQuery } from "@tanstack/react-query";
import type { AgentRunSummaryDto, RoomDto } from "@suduo/cloud-contracts";
import { MessagesSquareIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { settingsQuery } from "../../../app/queries.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { RegionError } from "../../../feedback/components/index.js";
import { useMediaQuery } from "../../../ui/use-breakpoint.js";
import { EMPTY_MESSAGES } from "../model.js";
import { NO_PANEL, type RoomPanelState } from "../panel.js";
import { hidePending, usePendingMessages } from "../pending.js";
import { useRoomMessages } from "../queries.js";
import { useRoomReadMarker } from "../read-marker.js";
import { clamp, SIDE_DEFAULT_WIDTH, SIDE_MIN_WIDTH, sideLayout } from "../window/geometry.js";
import { readSideWidth, writeSideWidth } from "../window/prefs.js";
import { MessageStream } from "./MessageStream.js";
import { RoomComposer } from "./RoomComposer.js";
import { ThreadPanel } from "./ThreadPanel.js";

/**
 * 房间的对话区：消息流 + 输入框 + 右侧话题 / 运行详情。讨论页与悬浮窗口共用这一份（不含房间头部）。
 * 话题开在哪由调用方给（panel + onPanelChange）：讨论页写 URL，悬浮窗口放组件状态。
 * layout 只管右侧栏怎么摆：
 * - page：话题 400 / 运行详情 560 固定宽；屏幕窄于 1280 时浮在消息流上；
 * - window：窗口够宽在右侧分栏、分隔线可左右拖（宽度记在本浏览器），太窄就盖住整个窗口。
 * active=false（悬浮窗口收起）时不算「正在看」、不记已读。
 */
const SIDE_BY_SIDE_QUERY = "(min-width: 1280px)";

export function RoomSkeleton() {
  return (
    <div className="flex flex-1 flex-col" aria-busy="true" aria-label="正在打开讨论">
      <div className="flex h-[52px] items-center border-b border-border px-5">
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="flex flex-1 flex-col justify-end gap-4 p-5">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-11 w-full" />
      </div>
    </div>
  );
}

export function RoomBody({
  room,
  panel,
  onPanelChange,
  layout = "page",
  active = true,
}: {
  room: RoomDto;
  panel: RoomPanelState;
  onPanelChange(next: RoomPanelState): void;
  layout?: "page" | "window";
  active?: boolean;
}) {
  const settings = useQuery(settingsQuery).data;
  const meId = settings?.session?.user.id ?? null;
  const messages = useRoomMessages(room.id);
  const pending = usePendingMessages(room.id, null);
  const data = messages.data ?? EMPTY_MESSAGES;
  const shownPending = hidePending(pending, data.items);
  const onViewState = useRoomReadMarker(room.id, { lastReadSeq: room.viewer.lastReadSeq, enabled: room.viewer.joined, active });

  const openThread = useCallback((rootId: string) => onPanelChange({ thread: rootId, run: null }), [onPanelChange]);
  const openRun = useCallback((run: AgentRunSummaryDto) => onPanelChange({ thread: run.threadRootId, run: run.id }), [onPanelChange]);
  const threadId = panel.thread;

  const thread =
    threadId === null ? null : (
      <ThreadPanel
        room={room}
        rootId={threadId}
        runId={panel.run}
        meId={meId}
        onClose={() => onPanelChange(NO_PANEL)}
        onOpenRun={openRun}
        onCloseRun={() => onPanelChange({ thread: threadId, run: null })}
      />
    );

  const main = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {messages.isPending ? (
        <div className="flex flex-1 flex-col justify-end gap-4 p-5" aria-busy="true" aria-label="正在加载消息">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-10 w-1/2" />
        </div>
      ) : messages.isError && messages.data === undefined ? (
        <div className="flex flex-1 items-center justify-center">
          <RegionError
            kind={classifyFailure(messages.error).kind}
            message={`查不到消息：${classifyFailure(messages.error).message}`}
            busy={messages.isFetching}
            onRetry={() => void messages.refetch()}
          />
        </div>
      ) : (
        <MessageStream
          data={data}
          pending={shownPending}
          meId={meId}
          loadingOlder={messages.loadingOlder}
          onLoadOlder={() => void messages.loadOlder()}
          onOpenThread={openThread}
          onOpenRun={openRun}
          onViewState={onViewState}
          empty={
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center" data-testid="room-empty">
              <MessagesSquareIcon className="size-6 text-subtle-foreground" aria-hidden="true" />
              <p className="m-0 text-body font-semibold text-foreground">还没有消息</p>
              <p className="m-0 max-w-[420px] text-small text-muted-foreground">
                发第一条消息开始讨论；同事把 Codex 共享进来后，@ 它就能直接问代码层面的问题。
              </p>
            </div>
          }
        />
      )}
      <div className={cn("shrink-0 pt-1", layout === "window" ? "px-3 pb-3" : "px-5 pb-4")}>
        <RoomComposer
          room={room}
          threadRootId={null}
          placeholder={`在「${room.name}」里发消息，@ 同事或共享进来的 Agent`}
          autoFocus
        />
      </div>
    </div>
  );

  return layout === "window" ? (
    <WindowSplit main={main} side={thread} />
  ) : (
    <PageSplit main={main} side={thread} wide={panel.run !== null} />
  );
}

/** 讨论页：右侧栏固定宽；窄屏浮在消息流上。 */
function PageSplit({ main, side, wide }: { main: ReactNode; side: ReactNode; wide: boolean }) {
  const sideBySide = useMediaQuery(SIDE_BY_SIDE_QUERY);
  return (
    <div className="relative flex min-h-0 flex-1">
      {main}
      {side === null ? null : (
        <div
          className={cn(
            "flex min-h-0 shrink-0 flex-col border-l border-border bg-card",
            wide ? "w-[560px]" : "w-[400px]",
            sideBySide ? "relative" : "absolute inset-y-0 right-0 z-20 max-w-[calc(100%-48px)] shadow-dialog",
          )}
        >
          {side}
        </div>
      )}
    </div>
  );
}

const DIVIDER_KEY_STEP = 16;

/** 悬浮窗口：右侧分栏，分隔线可拖动 / 用 ←→ 调整；窗口太窄时右侧栏盖住整个窗口。 */
function WindowSplit({ main, side }: { main: ReactNode; side: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidth = useElementWidth(containerRef);
  const [stored, setStored] = useState(() => readSideWidth() ?? SIDE_DEFAULT_WIDTH);
  const [dragWidth, setDragWidthState] = useState<number | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const layout = sideLayout(dragWidth ?? stored, containerWidth);

  const setDragWidth = (width: number | null) => {
    dragWidthRef.current = width;
    setDragWidthState(width);
  };
  const commit = (width: number) => {
    setStored(width);
    writeSideWidth(width);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || layout.mode !== "split") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: layout.width };
    setDragWidth(layout.width);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start === null || start.pointerId !== event.pointerId) return;
    // 分隔线往左拖，右侧栏变宽。
    const next = sideLayout(start.width - (event.clientX - start.x), containerWidth);
    if (next.mode === "split") setDragWidth(next.width);
  };
  const onPointerEnd = () => {
    if (drag.current === null) return;
    drag.current = null;
    const width = dragWidthRef.current;
    setDragWidth(null);
    if (width !== null) commit(width);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (layout.mode !== "split") return;
    const delta = event.key === "ArrowLeft" ? DIVIDER_KEY_STEP : event.key === "ArrowRight" ? -DIVIDER_KEY_STEP : 0;
    if (delta === 0) return;
    event.preventDefault();
    commit(clamp(layout.width + delta, SIDE_MIN_WIDTH, layout.max));
  };

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-1">
      {/* 话题盖满窗口时，被盖住的消息流与输入框不能再被 Tab 到。 */}
      <div className="contents" inert={side !== null && layout.mode === "cover"}>
        {main}
      </div>
      {side === null ? null : layout.mode === "cover" ? (
        <div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-card" data-testid="room-window-side" data-mode="cover">
          {side}
        </div>
      ) : (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整话题栏宽度"
            aria-valuenow={Math.round(layout.width)}
            aria-valuemin={SIDE_MIN_WIDTH}
            aria-valuemax={Math.round(layout.max)}
            tabIndex={0}
            className={cn(
              "group relative z-10 -mr-px w-px shrink-0 cursor-col-resize touch-none bg-border outline-none",
              "before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-['']",
              "hover:bg-primary focus-visible:bg-primary",
              dragWidth !== null && "bg-primary",
            )}
            data-testid="room-window-divider"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onKeyDown={onKeyDown}
          />
          <div
            className="flex min-h-0 shrink-0 flex-col bg-card"
            style={{ width: layout.width }}
            data-testid="room-window-side"
            data-mode="split"
          >
            {side}
          </div>
        </>
      )}
    </div>
  );
}

/** 元素宽度：ResizeObserver 跟随窗口拉伸；量不到（测试环境）时为 0。 */
function useElementWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
