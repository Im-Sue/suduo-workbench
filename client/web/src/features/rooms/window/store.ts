import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { NO_PANEL, searchFromPanel, type RoomPanelState } from "../panel.js";

/**
 * 讨论悬浮窗口的状态（需求 R2：同时只有一个窗口，打开别的房间替换内容）。
 * 外壳级、跨页面：切换路由不丢；不进 URL、不进存储（刷新后窗口不自动重开，位置大小另记在 prefs.ts）。
 * 打开房间只有一个入口：useRoomWindow().open(projectId, roomId)——需求预览面板、悬浮入口、窗口里的切换都走它。
 */
export interface RoomWindowState {
  projectId: string;
  roomId: string;
  /** 收起到悬浮入口：窗口内容保留（滚动位置、话题、草稿），只是不显示、不算「正在看」。 */
  minimized: boolean;
  panel: RoomPanelState;
  /** 每次打开 / 恢复都加一：窗口据此把焦点放进输入框（已经开着同一个房间时也要回到输入框）。 */
  focusRequest: number;
}

/** 窄于 640 不弹窗口、不显示悬浮入口（需求 R6）。 */
export const NARROW_VIEWPORT_QUERY = "(max-width: 639px)";

let state: RoomWindowState | null = null;
const listeners = new Set<() => void>();

function set(next: RoomWindowState | null): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

export function getRoomWindowState(): RoomWindowState | null {
  return state;
}

/** 打开（或换成）某个房间：同一个房间只是恢复显示，话题面板不动；换房间时面板清空。 */
export function openRoomWindow(projectId: string, roomId: string): void {
  const focusRequest = (state?.focusRequest ?? 0) + 1;
  if (state !== null && state.roomId === roomId) {
    set({ ...state, projectId, minimized: false, focusRequest });
    return;
  }
  set({ projectId, roomId, minimized: false, panel: NO_PANEL, focusRequest });
}

export function closeRoomWindow(): void {
  set(null);
}

export function setRoomWindowMinimized(minimized: boolean): void {
  if (state === null || state.minimized === minimized) return;
  set({ ...state, minimized, focusRequest: minimized ? state.focusRequest : state.focusRequest + 1 });
}

export function setRoomWindowPanel(panel: RoomPanelState): void {
  if (state === null) return;
  if (state.panel.thread === panel.thread && state.panel.run === panel.run) return;
  set({ ...state, panel });
}

export function useRoomWindowState(): RoomWindowState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => null,
  );
}

export function isNarrowViewport(): boolean {
  if (typeof window === "undefined") return false;
  return typeof window.matchMedia === "function" ? window.matchMedia(NARROW_VIEWPORT_QUERY).matches : window.innerWidth < 640;
}

export interface RoomWindowControls {
  state: RoomWindowState | null;
  /** 在悬浮窗口里打开房间；窄屏直接进讨论页。 */
  open(projectId: string, roomId: string): void;
  close(): void;
  minimize(): void;
  restore(): void;
  /** 「在讨论页打开」：关掉窗口，带着开着的话题跳到房间整页。 */
  openInPage(): void;
}

export function useRoomWindow(): RoomWindowControls {
  const navigate = useNavigate();
  const current = useRoomWindowState();
  const open = useCallback(
    (projectId: string, roomId: string) => {
      if (isNarrowViewport()) {
        void navigate({ to: "/p/$projectId/rooms/$roomId", params: { projectId, roomId } });
        return;
      }
      openRoomWindow(projectId, roomId);
    },
    [navigate],
  );
  const openInPage = useCallback(() => {
    const opened = getRoomWindowState();
    if (opened === null) return;
    closeRoomWindow();
    void navigate({
      to: "/p/$projectId/rooms/$roomId",
      params: { projectId: opened.projectId, roomId: opened.roomId },
      search: searchFromPanel(opened.panel),
    });
  }, [navigate]);
  return useMemo(
    () => ({
      state: current,
      open,
      close: closeRoomWindow,
      minimize: () => setRoomWindowMinimized(true),
      restore: () => setRoomWindowMinimized(false),
      openInPage,
    }),
    [current, open, openInPage],
  );
}
