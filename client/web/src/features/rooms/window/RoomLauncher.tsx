import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { RoomDto } from "@suduo/cloud-contracts";
import { ListIcon, MessagesSquareIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { useCurrentProject } from "../../../app/project-context.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { useMediaQuery } from "../../../ui/use-breakpoint.js";
import { MentionBadge, RoomKindIcon, roomAccessibleLabel, UnreadBadge } from "../components/RoomBadges.js";
import { hasUnreadMention, quickAccessRooms, totalUnread } from "../model.js";
import { findCachedRoom } from "../cache.js";
import { projectRoomsQuery } from "../queries.js";
import {
  clamp,
  clampLauncher,
  clampLauncherPoint,
  DEFAULT_LAUNCHER_POSITION,
  FAN_ANCHOR_SLOT,
  FAN_STEP,
  fanSlot,
  fanVisibleCount,
  LAUNCHER_MARGIN,
  LAUNCHER_SIZE,
  launcherPoint,
  snapLauncher,
  type FanSlot,
  type LauncherPosition,
  type Viewport,
} from "./geometry.js";
import { readLauncherPosition, writeLauncherPosition } from "./prefs.js";
import { NARROW_VIEWPORT_QUERY, useRoomWindow } from "./store.js";
import { useViewport } from "./use-viewport.js";

/**
 * 讨论悬浮入口（快捷入口需求「悬浮入口」）：任何页面右下角一个圆形按钮。
 * - 角标：当前项目各房间未读合计；有人 @ 我时另有「@」；
 * - 可拖动，松手吸附到最近的一边（左 / 右），高度就地保留；位置记在本浏览器（R3）；
 * - 点开是「扇形叠放」（像 Mac 程序坞的下载 / 废纸篓）：房间沿一条从按钮向上的弧线排开，越远越小越淡；
 *   一屏最多约 8 个，更多时滚轮 / 触控板 / ↑↓ 沿弧线滚动，两端渐隐；最下面固定「全部讨论…」；
 *   系统开了「减少动态效果」时改成普通竖排列表；
 * - 只列当前项目未归档的房间，@ 我 > 有未读 > 最近消息（R1）；
 * - 悬浮窗口收起时，点按钮直接恢复窗口；
 * - 窄于 640 不显示（R6）；登录 / 初始化页不在应用外壳里，自然不显示。
 * 读屏与键盘：按钮 aria-haspopup=listbox；叠放是 listbox / option，焦点留在列表上（aria-activedescendant），
 * ↑↓ Home End 移动、Enter 打开、Esc 收起并回到按钮，Tab 离开即收起。
 */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** 按下后移动超过这么多才算拖动，否则是点击。 */
const DRAG_THRESHOLD = 4;
/** 触屏手指会抖，按下后挪得再远一点才算拖动。 */
const TOUCH_DRAG_THRESHOLD = 10;
/** 滚轮停下后吸附到整格。 */
const SNAP_AFTER_MS = 140;
const NO_FADE = { fadeNear: false, fadeFar: false };

export function RoomLauncher() {
  const narrow = useMediaQuery(NARROW_VIEWPORT_QUERY);
  const { project } = useCurrentProject();
  if (narrow || project === null) return null;
  // 换项目时叠放收起、重新取房间。
  return <Launcher key={project.id} projectId={project.id} />;
}

interface Press {
  pointerId: number;
  x: number;
  y: number;
  origin: { x: number; y: number };
  dragging: boolean;
  /** 挪多远才算拖动（触屏更大）。 */
  threshold: number;
}

function Launcher({ projectId }: { projectId: string }) {
  const viewport = useViewport();
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const navigate = useNavigate();
  const roomWindow = useRoomWindow();
  const rooms = useQuery(projectRoomsQuery(projectId));
  const ordered = useMemo(() => quickAccessRooms(rooms.data?.items ?? []), [rooms.data]);
  const unread = totalUnread(rooms.data?.items);
  const mentioned = hasUnreadMention(rooms.data?.items);

  const [position, setPosition] = useState<LauncherPosition>(() => readLauncherPosition() ?? DEFAULT_LAUNCHER_POSITION);
  const docked = clampLauncher(position, viewport);
  const home = launcherPoint(docked, viewport);
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null);
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  const windowState = roomWindow.state;
  const stashed = windowState !== null && windowState.minimized ? windowState : null;
  const queryClient = useQueryClient();
  // 收起的窗口可能属于别的项目：从房间缓存里找名字，不只在当前项目的列表里找。
  const stashedName = stashed === null ? null : (findCachedRoom(queryClient, stashed.roomId)?.name ?? "讨论");

  const close = useCallback((focusButton: boolean) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }, []);

  const activate = useCallback(
    (option: StackOption) => {
      setOpen(false);
      if (option.kind === "all") {
        void navigate({ to: "/p/$projectId/rooms", params: { projectId } });
        return;
      }
      roomWindow.open(projectId, option.room.id);
    },
    [navigate, projectId, roomWindow],
  );

  // ---------- 拖动与吸附 ----------
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    suppressClick.current = false;
    press.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: home,
      dragging: false,
      threshold: event.pointerType === "touch" ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.dragging) {
      if (Math.hypot(dx, dy) < current.threshold) return;
      current.dragging = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setOpen(false);
    }
    setDragPoint(clampLauncherPoint({ x: current.origin.x + dx, y: current.origin.y + dy }, viewport));
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    press.current = null;
    if (!current.dragging) return;
    // 拖完松手不算点击；触屏拖完浏览器可能不派发 click，下一轮就复位，免得吞掉之后的键盘 Enter。
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    const dropped = clampLauncherPoint({ x: current.origin.x + event.clientX - current.x, y: current.origin.y + event.clientY - current.y }, viewport);
    const next = snapLauncher(dropped, viewport);
    setPosition(next);
    writeLauncherPosition(next);
    setDragPoint(null);
  };
  const onPointerCancel = () => {
    press.current = null;
    setDragPoint(null);
  };

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    // 键盘触发的 click（detail 为 0）不受「拖完不算点击」影响。
    if (suppressClick.current && event.detail !== 0) {
      suppressClick.current = false;
      return;
    }
    if (stashed !== null) {
      roomWindow.restore();
      return;
    }
    setOpen((value) => !value);
  };

  const label =
    (stashed === null ? "讨论快捷入口" : `恢复讨论窗口：${stashedName ?? "讨论"}`) +
    (unread > 0 ? `，${unread} 条未读` : "") +
    (mentioned ? "，有人 @ 你" : "");
  const point = dragPoint ?? home;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cn(
          "fixed top-0 left-0 z-45 flex size-12 touch-none items-center justify-center rounded-full border border-border-strong bg-card text-foreground shadow-overlay outline-none select-none",
          "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          dragPoint === null ? "transition-transform duration-(--dur-base) ease-(--ease-enter)" : "cursor-grabbing",
          open && "bg-muted",
        )}
        style={{ transform: `translate3d(${point.x}px, ${point.y}px, 0)` }}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        title={stashed === null ? "讨论（可拖到左边）" : `恢复「${stashedName ?? "讨论"}」`}
        data-testid="room-launcher"
        data-side={docked.side}
        data-unread={unread}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" && !open && stashed === null) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MessagesSquareIcon className="size-5" aria-hidden="true" />
        {/* 窗口收起在这里：底部一道短横（同程序坞「已打开」的指示）。 */}
        {stashed === null ? null : <span className="absolute bottom-1 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-primary" aria-hidden="true" />}
        <UnreadBadge count={unread} className="absolute -top-1 -right-1 ring-2 ring-background" />
        {mentioned ? <MentionBadge className="absolute -top-1 -left-1 ring-2 ring-background" /> : null}
      </button>
      {open ? (
        <RoomStack
          id={listboxId}
          mode={reducedMotion ? "list" : "fan"}
          rooms={ordered}
          status={rooms.data !== undefined ? null : rooms.isError ? `查不到讨论：${classifyFailure(rooms.error).message}` : "正在加载讨论…"}
          currentRoomId={windowState?.roomId ?? null}
          viewport={viewport}
          docked={docked}
          buttonRef={buttonRef}
          onActivate={activate}
          onClose={close}
        />
      ) : null}
    </>
  );
}

type StackOption = { key: string; kind: "room"; room: RoomDto; rank: number } | { key: "all"; kind: "all" };

/**
 * 叠放本身。选项的 DOM 顺序与屏幕上从上到下一致（↑ 往上、↓ 往下）：
 * 扇形是「最远的房间 … 最重要的房间、全部讨论」，普通列表是「最重要的房间 … 、全部讨论」。
 */
function RoomStack({
  id,
  mode,
  rooms,
  status,
  currentRoomId,
  viewport,
  docked,
  buttonRef,
  onActivate,
  onClose,
}: {
  id: string;
  mode: "fan" | "list";
  rooms: readonly RoomDto[];
  /** 房间还没取到时的说明（加载中 / 查不到）。 */
  status: string | null;
  currentRoomId: string | null;
  viewport: Viewport;
  docked: LauncherPosition;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onActivate(option: StackOption): void;
  onClose(focusButton: boolean): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const options = useMemo<StackOption[]>(() => {
    const roomOptions = rooms.map((room, rank) => ({ key: room.id, kind: "room" as const, room, rank }));
    return [...(mode === "fan" ? roomOptions.toReversed() : roomOptions), { key: "all", kind: "all" }];
  }, [mode, rooms]);
  const indexOfRank = useCallback((rank: number) => (mode === "fan" ? rooms.length - 1 - rank : rank), [mode, rooms.length]);
  // 高亮按选项记（不按位置）：开着时来了新消息、顺序变了，高亮仍跟着原来那个房间；没选过时落在最重要的房间上。
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const found = activeKey === null ? -1 : options.findIndex((option) => option.key === activeKey);
  const activeIndex = found >= 0 ? found : rooms.length === 0 ? options.length - 1 : indexOfRank(0);
  const visible = fanVisibleCount(viewport, docked);
  const maxScroll = Math.max(0, rooms.length - visible);
  const [scroll, setScroll] = useState(0);
  const [expanded, setExpanded] = useState(mode === "list");
  const [settled, setSettled] = useState(mode === "list");
  const snapTimer = useRef<number | undefined>(undefined);
  // 滚动途中房间数变了（来了新房间、浏览器缩放）也不重挂滚轮监听，免得清掉停下后的整格吸附。
  const maxScrollRef = useRef(maxScroll);
  maxScrollRef.current = maxScroll;
  // 房间变少时滚动收回范围内。
  const scrollPos = clamp(scroll, 0, maxScroll);

  /** 让第 rank 个房间落在一屏之内。 */
  const reveal = useCallback(
    (rank: number) => setScroll((current) => clamp(rank < current ? rank : rank > current + visible - 1 ? rank - visible + 1 : current, 0, maxScroll)),
    [maxScroll, visible],
  );

  const select = useCallback(
    (index: number) => {
      const option = options[clamp(index, 0, options.length - 1)];
      if (option === undefined) return;
      setActiveKey(option.key);
      if (option.kind === "room") reveal(option.rank);
      if (mode === "list") document.getElementById(`${id}-${option.key}`)?.scrollIntoView?.({ block: "nearest" });
    },
    [id, mode, options, reveal],
  );

  // 打开：焦点进列表；扇形下一帧从按钮处展开。
  useEffect(() => {
    listRef.current?.focus();
    if (mode === "list") return undefined;
    const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (callback: () => void) => window.setTimeout(callback, 16);
    const cancel = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : window.clearTimeout;
    const handle = frame(() => setExpanded(true));
    const done = window.setTimeout(() => setSettled(true), 400);
    return () => {
      cancel(handle);
      window.clearTimeout(done);
    };
  }, [mode]);

  // 点空白处收起（按钮自己的点击由按钮处理）。
  useEffect(() => {
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (listRef.current?.contains(target) === true || buttonRef.current?.contains(target) === true) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [buttonRef, onClose]);

  // 滚轮 / 触控板沿弧线滚动（要 preventDefault，不能用 React 的被动监听）；停下后吸附到整格，高亮跟进一屏之内。
  useEffect(() => {
    const element = listRef.current;
    if (element === null || mode !== "fan") return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      setScroll((current) => clamp(current - (event.deltaY * unit) / FAN_STEP, 0, maxScrollRef.current));
      window.clearTimeout(snapTimer.current);
      snapTimer.current = window.setTimeout(() => setScroll((current) => Math.round(current)), SNAP_AFTER_MS);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      window.clearTimeout(snapTimer.current);
    };
  }, [mode]);

  // 滚动后高亮的房间滚出了一屏：挪到最近的一端。
  useEffect(() => {
    if (mode !== "fan" || scrollPos !== Math.round(scrollPos)) return;
    const option = options[activeIndex];
    if (option?.kind !== "room") return;
    const rank = clamp(option.rank, scrollPos, scrollPos + visible - 1);
    if (rank !== option.rank) setActiveKey(options[indexOfRank(rank)]?.key ?? null);
  }, [activeIndex, indexOfRank, mode, options, scrollPos, visible]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowUp":
        select(activeIndex - 1);
        break;
      case "ArrowDown":
        select(activeIndex + 1);
        break;
      case "Home":
        select(0);
        break;
      case "End":
        select(options.length - 1);
        break;
      case "Enter":
      case " ": {
        const option = options[activeIndex];
        if (option !== undefined) onActivate(option);
        break;
      }
      case "Escape":
        onClose(true);
        break;
      case "Tab":
        onClose(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const activeOption = options[activeIndex];
  const common = {
    ref: listRef,
    id,
    role: "listbox",
    tabIndex: 0,
    "aria-label": "本项目的讨论",
    "aria-activedescendant": activeOption === undefined ? undefined : `${id}-${activeOption.key}`,
    "data-state": "open",
    "data-mode": mode,
    onKeyDown,
  } as const;

  const renderOption = (option: StackOption, index: number, slot: FanSlot | null) => {
    const selected = index === activeIndex;
    const isAll = option.kind === "all";
    const room = isAll ? null : option.room;
    const hidden = slot !== null && slot.opacity < 0.05;
    const label = room === null ? "全部讨论…，进入讨论页" : `${roomAccessibleLabel(room)}${room.id === currentRoomId ? "，已在窗口里打开" : ""}`;
    const optionProps = {
      id: `${id}-${option.key}`,
      role: "option",
      "aria-selected": selected,
      "aria-label": label,
      "data-kind": option.kind,
      "data-room-id": room?.id,
      onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(),
      onPointerEnter: () => {
        if (!hidden) setActiveKey(option.key);
      },
      onClick: () => onActivate(option),
    } as const;

    const icon = (
      <span
        className={cn(
          "relative flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-overlay",
          room !== null && room.id === currentRoomId && "ring-2 ring-primary",
        )}
        aria-hidden="true"
      >
        {room === null ? <ListIcon className="size-4" /> : <RoomKindIcon room={room} className="size-4 text-muted-foreground" />}
        {room === null ? null : <UnreadBadge count={room.viewer.unreadCount} className="absolute -top-1 -right-1 ring-2 ring-card" />}
        {room !== null && room.viewer.mentionCount > 0 ? <MentionBadge className="absolute -top-1 -left-1 ring-2 ring-card" /> : null}
      </span>
    );

    if (slot === null) {
      // 普通列表（减少动态效果）。
      return (
        <div
          key={option.key}
          {...optionProps}
          data-testid="room-launcher-item"
          className={cn(
            "flex h-9 cursor-pointer items-center gap-2 rounded-[5px] px-2 text-small text-popover-foreground",
            selected && "bg-popover-hover",
          )}
        >
          {room === null ? <ListIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" /> : <RoomKindIcon room={room} />}
          <span className={cn("min-w-0 flex-1 truncate", room !== null && room.viewer.unreadCount > 0 && "font-semibold")}>
            {room === null ? "全部讨论…" : room.name}
          </span>
          {room !== null && room.id === currentRoomId ? <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" /> : null}
          {room !== null && room.viewer.mentionCount > 0 ? <MentionBadge /> : null}
          {room === null ? null : <UnreadBadge count={room.viewer.unreadCount} />}
        </div>
      );
    }

    const toward = docked.side === "right" ? -1 : 1;
    const depth = isAll ? 0 : 1 + option.rank - scrollPos;
    return (
      <div
        key={option.key}
        {...optionProps}
        data-testid="room-launcher-item"
        aria-hidden={hidden || undefined}
        className={cn(
          "absolute bottom-0 flex cursor-pointer items-center gap-2 will-change-transform",
          docked.side === "right" ? "right-1 origin-right flex-row-reverse" : "left-1 origin-left",
          "transition-[transform,opacity] duration-200 ease-(--ease-enter)",
          hidden && "pointer-events-none",
        )}
        style={{
          transform: `translate3d(${toward * slot.inset}px, ${slot.y}px, 0) scale(${slot.scale})`,
          opacity: slot.opacity,
          transitionDelay: settled ? "0ms" : `${Math.round(clamp(depth, 0, visible) * 18)}ms`,
        }}
      >
        {icon}
        <span
          className={cn(
            "max-w-[220px] truncate rounded-md px-2.5 py-1 text-small font-medium shadow-overlay",
            selected ? "bg-primary text-primary-foreground" : "bg-popover text-popover-foreground",
          )}
        >
          {room === null ? "全部讨论…" : room.name}
        </span>
      </div>
    );
  };

  if (mode === "list") {
    const roomOptions = options.slice(0, -1);
    const all = options.at(-1);
    return (
      <div
        {...common}
        data-testid="room-launcher-stack"
        className="fixed z-45 flex w-[280px] flex-col rounded-md bg-popover p-1 text-popover-foreground shadow-overlay outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{
          bottom: docked.bottom + LAUNCHER_SIZE + 8,
          ...(docked.side === "right" ? { right: LAUNCHER_MARGIN } : { left: LAUNCHER_MARGIN }),
          maxHeight: Math.max(160, Math.min(440, viewport.height - docked.bottom - LAUNCHER_SIZE - 24)),
        }}
      >
        <div role="presentation" className="min-h-0 flex-1 overflow-y-auto">
          {status === null ? null : <p className="m-0 px-2 py-2 text-small text-subtle-foreground">{status}</p>}
          {status === null && rooms.length === 0 ? <p className="m-0 px-2 py-2 text-small text-subtle-foreground">这个项目还没有讨论</p> : null}
          {roomOptions.map((option, index) => renderOption(option, index, null))}
        </div>
        <div role="presentation" className="mt-1 border-t border-border pt-1">
          {all === undefined ? null : renderOption(all, options.length - 1, null)}
        </div>
      </div>
    );
  }

  const point = launcherPoint(docked, viewport);
  const ends = { fadeNear: scrollPos > 0.01, fadeFar: scrollPos < maxScroll - 0.01 };
  const collapsed: FanSlot = { inset: 0, y: 0, scale: 0.6, opacity: 0 };
  const fanHeight = (Math.min(visible, Math.max(rooms.length, 1)) + 1) * FAN_STEP + 24;
  return (
    <div
      {...common}
      data-testid="room-launcher-stack"
      className="fixed top-0 left-0 z-45 h-0 outline-none"
      style={{ transform: `translate3d(${point.x}px, ${point.y}px, 0)`, width: LAUNCHER_SIZE }}
    >
      {/* 弧线所在的区域：接住滚轮；点到项与项之间的空白也算点空白，收起。 */}
      <div
        aria-hidden="true"
        className={cn("absolute bottom-0 w-[300px]", docked.side === "right" ? "right-0" : "left-0")}
        style={{ height: fanHeight }}
        onPointerDown={() => onClose(false)}
      />
      {status === null && rooms.length > 0 ? null : (
        <p
          className={cn(
            "absolute bottom-0 m-0 rounded-md bg-popover px-2.5 py-1 text-small whitespace-nowrap text-subtle-foreground shadow-overlay transition-[transform,opacity] duration-200",
            docked.side === "right" ? "right-1" : "left-1",
          )}
          style={{ transform: `translate3d(0, ${expanded ? -(10 + FAN_STEP + 8) : 0}px, 0)`, opacity: expanded ? 1 : 0 }}
        >
          {status ?? "这个项目还没有讨论"}
        </p>
      )}
      {options.map((option, index) => {
        if (!expanded) return renderOption(option, index, collapsed);
        if (option.kind === "all") return renderOption(option, index, FAN_ANCHOR_SLOT);
        // 高亮的那一项不做「还能滚」的提示性变淡。
        return renderOption(option, index, fanSlot(1 + option.rank - scrollPos, visible, index === activeIndex ? NO_FADE : ends));
      })}
    </div>
  );
}
