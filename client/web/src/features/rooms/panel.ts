/**
 * 房间右侧面板的状态：开着哪个话题、话题里是否在看某次运行的执行过程。
 * 讨论页把它写在 URL 里（`?thread=&run=`，可分享、可回退），悬浮窗口放在组件状态里（不动页面地址）；
 * 房间界面本身（RoomBody）只认「面板状态 + 改面板的回调」，不关心存在哪。
 */
export interface RoomPanelState {
  thread: string | null;
  /** 只在 thread 不为空时有意义。 */
  run: string | null;
}

export const NO_PANEL: RoomPanelState = { thread: null, run: null };

/** 讨论页地址里的面板参数（与路由的 validateRoomsSearch 同形）。 */
export interface RoomPanelSearch {
  thread?: string;
  run?: string;
}

export function panelFromSearch(search: RoomPanelSearch): RoomPanelState {
  const thread = search.thread ?? null;
  return { thread, run: thread === null ? null : (search.run ?? null) };
}

export function searchFromPanel(panel: RoomPanelState): RoomPanelSearch {
  if (panel.thread === null) return {};
  return panel.run === null ? { thread: panel.thread } : { thread: panel.thread, run: panel.run };
}
