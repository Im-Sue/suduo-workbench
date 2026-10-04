import { useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronsUpDownIcon, Maximize2Icon, MinusIcon, XIcon } from "lucide-react";
import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { settingsQuery } from "../../../app/queries.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { RegionError } from "../../../feedback/components/index.js";
import { useT } from "../../../i18n/provider.js";
import { useMediaQuery } from "../../../ui/use-breakpoint.js";
import { MentionBadge, RoomKindIcon, roomAccessibleLabel, UnreadBadge } from "../components/RoomBadges.js";
import { RoomBody } from "../components/RoomBody.js";
import { MembersButton } from "../components/RoomHeader.js";
import { ShareAgentButton } from "../components/ShareAgentPanel.js";
import { quickAccessRooms, roomRequirementCode } from "../model.js";
import type { RoomPanelState } from "../panel.js";
import { projectRoomsQuery, useJoinRoom, useRoom } from "../queries.js";
import { clampRect, defaultRect, moveRect, RESIZE_EDGES, resizeRect, type Rect, type ResizeEdge } from "./geometry.js";
import { readLauncherPosition, readWindowRect, writeWindowRect } from "./prefs.js";
import {
  closeRoomWindow,
  NARROW_VIEWPORT_QUERY,
  setRoomWindowPanel,
  useRoomWindow,
  useRoomWindowState,
  type RoomWindowState,
} from "./store.js";
import { currentViewport, useViewport } from "./use-viewport.js";

/**
 * 讨论悬浮窗口（快捷入口需求「悬浮窗口」，参照 Tutti 的群聊悬浮窗）：
 * - 只有一个，挂在应用外壳上，切换页面不卸载；打开别的房间替换内容（R2）；
 * - 按住标题栏拖动，四边四角八向拉伸，最小 360×420，不出浏览器（四周留 6px）；位置大小记在本浏览器（R3）；
 * - 层级在页面之上、对话框 / 菜单 / 提示之下（z-40；对话框 60、菜单 70、提示更高）；
 * - 标题栏：房间名与类型、成员头像、共享 Agent、房间切换、在讨论页打开、收起、关闭；
 * - 内容就是讨论页的对话区（RoomBody），话题 / 运行详情放组件状态、不动页面地址，在窗口右侧分栏；
 * - 打开且没收起时算「正在看」（R4），收起后内容原样保留、不显示；
 * - 窄于 640 不显示（R6；打开入口改为直接进讨论页，见 store.ts）。
 */
/** 挂着的 RoomWindow 数（外壳上只挂一个）。 */
let mountedWindows = 0;

export function RoomWindow() {
  const state = useRoomWindowState();
  const narrow = useMediaQuery(NARROW_VIEWPORT_QUERY);
  // 外壳卸载（退出登录、登录过期、进初始化页）时关掉：下一个登录的人不该看到上一个人开着的房间。
  // 切换语言按新语言重建整棵界面、开发模式 StrictMode 的二次执行，都是同一轮里先卸后挂，那不是离开：
  // 等这一轮跑完（微任务）还没有窗口挂着才关，窗口（含话题面板、草稿）原样留着。
  useEffect(() => {
    mountedWindows += 1;
    return () => {
      mountedWindows -= 1;
      queueMicrotask(() => {
        if (mountedWindows === 0) closeRoomWindow();
      });
    };
  }, []);
  if (state === null || narrow) return null;
  return <RoomWindowFrame state={state} />;
}

type GestureKind = "move" | ResizeEdge;

interface Gesture {
  kind: GestureKind;
  pointerId: number;
  x: number;
  y: number;
  start: Rect;
}

/** 八个拉伸把手：边 8px 宽、角 14px，压在窗口边框外沿上。 */
const HANDLE_CLASS: Record<ResizeEdge, string> = {
  n: "-top-1 right-3 left-3 h-2 cursor-ns-resize",
  s: "right-3 -bottom-1 left-3 h-2 cursor-ns-resize",
  e: "top-3 -right-1 bottom-3 w-2 cursor-ew-resize",
  w: "top-3 bottom-3 -left-1 w-2 cursor-ew-resize",
  ne: "-top-1.5 -right-1.5 size-3.5 cursor-nesw-resize",
  nw: "-top-1.5 -left-1.5 size-3.5 cursor-nwse-resize",
  se: "-right-1.5 -bottom-1.5 size-3.5 cursor-nwse-resize",
  sw: "-bottom-1.5 -left-1.5 size-3.5 cursor-nesw-resize",
};

const GESTURE_CURSOR: Record<GestureKind, string> = {
  move: "cursor-grabbing",
  n: "cursor-ns-resize",
  s: "cursor-ns-resize",
  e: "cursor-ew-resize",
  w: "cursor-ew-resize",
  ne: "cursor-nesw-resize",
  nw: "cursor-nwse-resize",
  se: "cursor-nwse-resize",
  sw: "cursor-nesw-resize",
};

/** 窗口窄于此时，标题栏的「共享 Agent」只留图标。 */
const COMPACT_HEADER_WIDTH = 520;

function isInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("button, a, input, textarea, select, [role='button'], [role='menuitem'], [data-no-drag]") !== null
  );
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function initialRect(): Rect {
  return readWindowRect() ?? defaultRect(currentViewport(), readLauncherPosition()?.side ?? "right");
}

function RoomWindowFrame({ state }: { state: RoomWindowState }) {
  const viewport = useViewport();
  const titleId = useId();
  const [rect, setRect] = useState<Rect>(initialRect);
  // 记下的是用户摆的位置；浏览器变小时只在显示上收进来，不改记录（变回大窗口时回到原处）。
  const shown = clampRect(rect, viewport);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const gesture = useRef<Gesture | null>(null);
  const [gestureKind, setGestureKind] = useState<GestureKind | null>(null);
  const frameRef = useRef<HTMLElement>(null);
  const minimized = state.minimized;
  // 收起时朝悬浮入口那一侧缩（每次收起 / 恢复时重读一次入口在哪边）。
  const origin = useMemo(() => (readLauncherPosition()?.side === "left" ? "origin-bottom-left" : "origin-bottom-right"), [minimized]);

  const next = (current: Gesture, event: PointerEvent<HTMLElement>): Rect => {
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    const view = currentViewport();
    return current.kind === "move" ? moveRect(current.start, dx, dy, view) : resizeRect(current.start, current.kind, dx, dy, view);
  };

  const begin = (kind: GestureKind) => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || minimized) return;
    if (kind === "move" && isInteractive(event.target)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = { kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: shownRef.current };
    setGestureKind(kind);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    setRect(next(current, event));
  };
  const onPointerEnd = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    setGestureKind(null);
    // 取消 / 丢了指针捕获（没收到 pointerup）：停在当前显示的位置，不让拖动遮罩一直盖着页面。
    const final = event.type === "pointerup" ? next(current, event) : shownRef.current;
    setRect(final);
    // 只是在标题栏上点了一下（没动）就不写：记录里保留用户摆的位置，不写进被收进浏览器后的显示位置。
    if (!sameRect(final, current.start)) writeWindowRect(final);
  };
  const gestureHandlers = (kind: GestureKind) => ({
    onPointerDown: begin(kind),
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    onLostPointerCapture: onPointerEnd,
  });

  // 收起：焦点交还悬浮入口。
  const wasMinimized = useRef(minimized);
  useEffect(() => {
    if (wasMinimized.current === minimized) return;
    wasMinimized.current = minimized;
    if (!minimized) return;
    const focused = document.activeElement;
    if (focused === null || focused === document.body || frameRef.current?.contains(focused) === true) {
      document.querySelector<HTMLElement>('[data-testid="room-launcher"]')?.focus();
    }
  }, [minimized]);
  // 每次打开 / 恢复（含已经开着同一个房间）：回到输入框接着聊。放到下一帧：刚换房间时输入框
  // 还没挂上，菜单关闭时也可能把焦点还给触发按钮。
  const focusRequest = state.focusRequest;
  useEffect(() => {
    if (minimized) return undefined;
    const frame = requestAnimationFrame(() => {
      frameRef.current?.querySelector<HTMLElement>('[data-testid="room-composer-input"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, minimized]);

  // 窗口里的按键不触发底下页面的单键快捷键（看板的 J/K/C、Esc 关速览等）；带修饰键的全局快捷键照常。
  const isolateKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    event.stopPropagation();
  };

  return (
    <>
      <section
        ref={frameRef}
        aria-labelledby={titleId}
        aria-hidden={minimized || undefined}
        inert={minimized}
        className={cn("fixed top-0 left-0 z-40", minimized && "pointer-events-none")}
        style={{ transform: `translate3d(${shown.x}px, ${shown.y}px, 0)`, width: shown.width, height: shown.height }}
        data-testid="room-window"
        data-room-id={state.roomId}
        data-minimized={minimized ? "true" : "false"}
        onKeyDown={isolateKeys}
      >
        <div
          className={cn(
            "flex size-full flex-col overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-dialog",
            "animate-in fade-in-0 zoom-in-95 duration-(--dur-base) ease-(--ease-enter)",
            origin,
            // 收起时 visibility 跟着过渡（播完再隐藏）；恢复时立刻可见，否则过渡起点仍是 hidden，输入框拿不到焦点。
            minimized
              ? "invisible scale-90 opacity-0 transition-[opacity,scale,visibility]"
              : "visible scale-100 opacity-100 transition-[opacity,scale]",
          )}
        >
          <div
            className={cn(
              "shrink-0 touch-none select-none [&_a]:cursor-pointer [&_button]:cursor-default",
              gestureKind === "move" ? "cursor-grabbing" : "cursor-grab",
            )}
            {...gestureHandlers("move")}
          >
            <RoomWindowHeader projectId={state.projectId} roomId={state.roomId} titleId={titleId} compact={shown.width < COMPACT_HEADER_WIDTH} />
          </div>
          <RoomWindowBody key={state.roomId} roomId={state.roomId} panel={state.panel} active={!minimized} />
        </div>
        {minimized
          ? null
          : RESIZE_EDGES.map((edge) => (
              <div
                key={edge}
                aria-hidden="true"
                className={cn("absolute touch-none", HANDLE_CLASS[edge])}
                data-testid="room-window-resize"
                data-edge={edge}
                {...gestureHandlers(edge)}
              />
            ))}
      </section>
      {/* 拖动 / 拉伸中：盖一层透明遮罩，光标保持形状、不误触底下的页面。 */}
      {gestureKind === null ? null : <div className={cn("fixed inset-0 z-41", GESTURE_CURSOR[gestureKind])} aria-hidden="true" />}
    </>
  );
}

const RoomWindowHeader = memo(function RoomWindowHeader({
  projectId,
  roomId,
  titleId,
  compact,
}: {
  projectId: string;
  roomId: string;
  titleId: string;
  compact: boolean;
}) {
  const t = useT();
  const text = t.rooms.window;
  const room = useRoom(roomId).data;
  const meId = useQuery(settingsQuery).data?.session?.user.id ?? null;
  const join = useJoinRoom();
  const roomWindow = useRoomWindow();
  const rawCode = room === undefined ? null : roomRequirementCode(room);
  // 名字里已经带了编号（缺省名「REQ-1 讨论」）就不再单独显示。
  const code = rawCode !== null && room !== undefined && !room.name.startsWith(rawCode) ? rawCode : null;
  const kindLabel = room === undefined ? "" : room.kind === "project_default" ? t.rooms.kind.project : t.rooms.kind.requirement;
  return (
    <header className="flex h-11 items-center gap-1 border-b border-border pr-1.5 pl-3" data-testid="room-window-header">
      {room === undefined ? null : <RoomKindIcon room={room} />}
      <h2
        id={titleId}
        className="m-0 ml-1 min-w-0 truncate text-small font-semibold text-foreground"
        title={room === undefined ? undefined : `${room.name} · ${kindLabel}${room.requirement === null ? "" : ` · ${room.requirement.title}`}`}
      >
        {room === undefined ? <Skeleton className="h-4 w-28" /> : room.name}
        {room === undefined ? null : <span className="sr-only">{text.kindSuffix(kindLabel)}</span>}
      </h2>
      {code === null ? null : <span className="shrink-0 font-mono text-caption text-subtle-foreground">{code}</span>}
      {room !== undefined && room.archivedAt !== null ? <Badge>{t.rooms.archived}</Badge> : null}
      <RoomSwitcher projectId={projectId} currentRoomId={roomId} onPick={(id) => roomWindow.open(projectId, id)} />
      <div className="min-w-1 flex-1" />
      {room === undefined ? null : <MembersButton room={room} />}
      {room !== undefined && !room.viewer.joined && room.kind === "requirement" ? (
        <Button size="sm" variant="secondary" loading={join.isPending} onClick={() => join.mutate({ roomId: room.id })}>
          {text.join}
        </Button>
      ) : null}
      {room === undefined ? null : <ShareAgentButton room={room} meId={meId} compact={compact} />}
      <ActionTip label={text.openInPage}>
        <Button size="icon-sm" variant="ghost" aria-label={text.openInPage} onClick={roomWindow.openInPage} data-testid="room-window-open-page">
          <Maximize2Icon />
        </Button>
      </ActionTip>
      <ActionTip label={text.minimize}>
        <Button size="icon-sm" variant="ghost" aria-label={text.minimize} onClick={roomWindow.minimize} data-testid="room-window-minimize">
          <MinusIcon />
        </Button>
      </ActionTip>
      <ActionTip label={text.close}>
        <Button size="icon-sm" variant="ghost" aria-label={text.close} onClick={roomWindow.close} data-testid="room-window-close">
          <XIcon />
        </Button>
      </ActionTip>
    </header>
  );
});

function ActionTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** 标题栏的房间切换：本窗口所在项目的未归档房间，顺序同悬浮入口（@ 我 > 未读 > 最近消息）。 */
function RoomSwitcher({ projectId, currentRoomId, onPick }: { projectId: string; currentRoomId: string; onPick(roomId: string): void }) {
  const t = useT();
  const text = t.rooms.window;
  const rooms = useQuery(projectRoomsQuery(projectId));
  const items = useMemo(() => quickAccessRooms(rooms.data?.items ?? []), [rooms.data]);
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="size-6" aria-label={text.switchRoom} data-testid="room-window-switcher">
              <ChevronsUpDownIcon className="size-3.5!" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{text.switchRoom}</TooltipContent>
      </Tooltip>
      {/* 选了房间后焦点交给窗口的输入框，不还给切换按钮（减少动态效果时菜单当场卸载，会抢在输入框之后还焦点）。 */}
      <DropdownMenuContent
        align="start"
        className="max-h-[min(420px,70vh)] w-64 overflow-y-auto"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuLabel>{text.projectRooms}</DropdownMenuLabel>
        {rooms.isPending ? <div className="px-2 py-1.5 text-small text-subtle-foreground">{text.loading}</div> : null}
        {rooms.isError && rooms.data === undefined ? (
          <div className="px-2 py-1.5 text-small text-danger">{t.rooms.loadFailed(classifyFailure(rooms.error).message)}</div>
        ) : null}
        {items.map((room) => (
          <DropdownMenuItem
            key={room.id}
            aria-label={roomAccessibleLabel(room, t)}
            aria-current={room.id === currentRoomId ? "true" : undefined}
            onSelect={() => onPick(room.id)}
            data-testid="room-window-switcher-item"
            data-room-id={room.id}
          >
            <RoomKindIcon room={room} />
            <span className={cn("min-w-0 flex-1 truncate", room.id === currentRoomId && "font-semibold")}>{room.name}</span>
            {room.viewer.mentionCount > 0 ? <MentionBadge /> : null}
            <UnreadBadge count={room.viewer.unreadCount} />
            {room.id === currentRoomId ? <CheckIcon className="text-primary-text!" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 窗口的内容区：只依赖房间 id、面板状态与是否在前面——拖动、拉伸时窗口框重渲染，这里不跟着重渲染。 */
const RoomWindowBody = memo(function RoomWindowBody({
  roomId,
  panel,
  active,
}: {
  roomId: string;
  panel: RoomPanelState;
  active: boolean;
}) {
  const t = useT();
  const room = useRoom(roomId);
  if (room.data === undefined) {
    if (room.isError) {
      const failure = classifyFailure(room.error);
      return (
        <div className="flex flex-1 items-center justify-center p-4">
          <RegionError
            kind={failure.kind}
            message={failure.status === 404 ? t.rooms.window.roomNotFound : t.rooms.roomLoadFailed(failure.message)}
            busy={room.isFetching}
            onRetry={() => void room.refetch()}
          />
        </div>
      );
    }
    return (
      <div className="flex flex-1 flex-col justify-end gap-4 p-4" aria-busy="true" aria-label={t.rooms.opening}>
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-11 w-full" />
      </div>
    );
  }
  return <RoomBody room={room.data} panel={panel} onPanelChange={setRoomWindowPanel} layout="window" active={active} />;
});
