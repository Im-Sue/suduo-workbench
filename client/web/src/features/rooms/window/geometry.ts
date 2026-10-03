/**
 * 讨论悬浮窗口与悬浮入口的几何计算（需求 suduo-v2-room-quick-access-001）。纯函数，无 React、无 DOM，单测直接覆盖：
 * - 窗口：拖动、八向拉伸、最小尺寸、不出浏览器（四周留 6px）；
 * - 窗口右侧话题栏：并排还是盖住整个窗口、宽度范围；
 * - 悬浮入口：吸附到最近的一边、上下位置范围；
 * - 扇形叠放：每一项沿弧线的位置、大小、透明度。
 */

export interface Viewport {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const RESIZE_EDGES: readonly ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** 窗口最小尺寸（需求：360×420）；浏览器比这还小时以浏览器为准。 */
export const WINDOW_MIN_WIDTH = 360;
export const WINDOW_MIN_HEIGHT = 420;
/** 窗口不能出浏览器：四周至少留这么多。 */
export const WINDOW_EDGE = 6;
const WINDOW_DEFAULT_WIDTH = 440;
const WINDOW_DEFAULT_HEIGHT = 640;
/** 默认位置给悬浮入口留出的一列，窗口不压住它。 */
const LAUNCHER_LANE = 84;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sizeLimits(viewport: Viewport) {
  const maxWidth = Math.max(0, viewport.width - 2 * WINDOW_EDGE);
  const maxHeight = Math.max(0, viewport.height - 2 * WINDOW_EDGE);
  return {
    maxWidth,
    maxHeight,
    minWidth: Math.min(WINDOW_MIN_WIDTH, maxWidth),
    minHeight: Math.min(WINDOW_MIN_HEIGHT, maxHeight),
  };
}

/** 把窗口收进浏览器：先定尺寸（最小值与浏览器之间），再把位置推回可见范围。 */
export function clampRect(rect: Rect, viewport: Viewport): Rect {
  const limits = sizeLimits(viewport);
  const width = clamp(rect.width, limits.minWidth, limits.maxWidth);
  const height = clamp(rect.height, limits.minHeight, limits.maxHeight);
  return {
    x: clamp(rect.x, WINDOW_EDGE, viewport.width - WINDOW_EDGE - width),
    y: clamp(rect.y, WINDOW_EDGE, viewport.height - WINDOW_EDGE - height),
    width,
    height,
  };
}

/** 按住标题栏拖动：从按下时的位置平移，碰到边就停住。 */
export function moveRect(start: Rect, dx: number, dy: number, viewport: Viewport): Rect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, viewport);
}

/**
 * 拖某条边 / 某个角拉伸：对边不动；不小于最小尺寸，也不拉出浏览器。
 * start 应是按下时屏幕上实际的窗口（已收进浏览器的）。
 */
export function resizeRect(start: Rect, edge: ResizeEdge, dx: number, dy: number, viewport: Viewport): Rect {
  const limits = sizeLimits(viewport);
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (edge.includes("w")) left = clamp(start.x + dx, Math.max(WINDOW_EDGE, right - limits.maxWidth), right - limits.minWidth);
  if (edge.includes("e")) right = clamp(right + dx, left + limits.minWidth, Math.min(viewport.width - WINDOW_EDGE, left + limits.maxWidth));
  if (edge.includes("n")) top = clamp(start.y + dy, Math.max(WINDOW_EDGE, bottom - limits.maxHeight), bottom - limits.minHeight);
  if (edge.includes("s")) bottom = clamp(bottom + dy, top + limits.minHeight, Math.min(viewport.height - WINDOW_EDGE, top + limits.maxHeight));
  return clampRect({ x: left, y: top, width: right - left, height: bottom - top }, viewport);
}

/** 第一次打开时的位置：靠悬浮入口那一侧的下方，给入口留出一列。 */
export function defaultRect(viewport: Viewport, side: LauncherSide): Rect {
  const width = Math.min(WINDOW_DEFAULT_WIDTH, viewport.width - 2 * WINDOW_EDGE);
  const height = clamp(viewport.height - 96, WINDOW_MIN_HEIGHT, WINDOW_DEFAULT_HEIGHT);
  const x = side === "right" ? viewport.width - LAUNCHER_LANE - width : LAUNCHER_LANE;
  return clampRect({ x, y: viewport.height - height - 16, width, height }, viewport);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 本浏览器记下的窗口位置大小：字段不全、不是数字（旧版本写入、手改、损坏）就当没有。 */
export function parseRect(raw: unknown): Rect | null {
  if (raw === null || typeof raw !== "object") return null;
  const { x, y, width, height } = raw as Record<string, unknown>;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

// ───────────────────────────── 窗口右侧话题栏 ─────────────────────────────

export const SIDE_MIN_WIDTH = 280;
export const MAIN_MIN_WIDTH = 280;
export const SIDE_DEFAULT_WIDTH = 360;

export type SideLayout = { mode: "split"; width: number; max: number } | { mode: "cover" };

/**
 * 话题 / 运行详情在窗口里怎么摆：窗口够宽就在右侧分栏（宽度可拖），太窄就盖住整个窗口（关掉回到消息流）。
 * 还没量到宽度（0）时先按分栏给。
 */
export function sideLayout(desired: number, containerWidth: number): SideLayout {
  const want = finite(desired) ? desired : SIDE_DEFAULT_WIDTH;
  if (containerWidth <= 0) return { mode: "split", width: Math.max(SIDE_MIN_WIDTH, want), max: Math.max(SIDE_MIN_WIDTH, want) };
  if (containerWidth < SIDE_MIN_WIDTH + MAIN_MIN_WIDTH) return { mode: "cover" };
  const max = containerWidth - MAIN_MIN_WIDTH;
  return { mode: "split", width: clamp(want, SIDE_MIN_WIDTH, max), max };
}

// ───────────────────────────── 悬浮入口 ─────────────────────────────

export type LauncherSide = "left" | "right";

export interface LauncherPosition {
  side: LauncherSide;
  /** 按钮下沿离浏览器底部的距离。 */
  bottom: number;
}

export const LAUNCHER_SIZE = 48;
export const LAUNCHER_MARGIN = 20;
const LAUNCHER_MIN_BOTTOM = 12;
/** 入口上方至少留这么高，扇形才排得开。 */
const LAUNCHER_HEADROOM = 320;
/** 默认高一点，不压住讨论页、会话页右下角的发送按钮。 */
export const DEFAULT_LAUNCHER_POSITION: LauncherPosition = { side: "right", bottom: 120 };

export function clampLauncher(position: LauncherPosition, viewport: Viewport): LauncherPosition {
  const max = Math.max(LAUNCHER_MIN_BOTTOM, viewport.height - LAUNCHER_SIZE - LAUNCHER_HEADROOM);
  return { side: position.side, bottom: clamp(position.bottom, LAUNCHER_MIN_BOTTOM, max) };
}

/** 停靠时按钮左上角在屏幕上的坐标。 */
export function launcherPoint(position: LauncherPosition, viewport: Viewport): { x: number; y: number } {
  const docked = clampLauncher(position, viewport);
  return {
    x: docked.side === "right" ? viewport.width - LAUNCHER_MARGIN - LAUNCHER_SIZE : LAUNCHER_MARGIN,
    y: viewport.height - docked.bottom - LAUNCHER_SIZE,
  };
}

/** 拖动中按钮跟手，但不出浏览器。 */
export function clampLauncherPoint(point: { x: number; y: number }, viewport: Viewport): { x: number; y: number } {
  return {
    x: clamp(point.x, 0, Math.max(0, viewport.width - LAUNCHER_SIZE)),
    y: clamp(point.y, 0, Math.max(0, viewport.height - LAUNCHER_SIZE)),
  };
}

/** 松手：按按钮中心落在哪半边吸附到左 / 右，高度就地保留（在可用范围内）。 */
export function snapLauncher(point: { x: number; y: number }, viewport: Viewport): LauncherPosition {
  const centerX = point.x + LAUNCHER_SIZE / 2;
  const side: LauncherSide = centerX < viewport.width / 2 ? "left" : "right";
  return clampLauncher({ side, bottom: viewport.height - point.y - LAUNCHER_SIZE }, viewport);
}

export function parseLauncherPosition(raw: unknown): LauncherPosition | null {
  if (raw === null || typeof raw !== "object") return null;
  const { side, bottom } = raw as Record<string, unknown>;
  if ((side !== "left" && side !== "right") || !finite(bottom)) return null;
  return { side, bottom };
}

// ───────────────────────────── 扇形叠放 ─────────────────────────────

/** 相邻两项的间距（每项 40px 高）。 */
export const FAN_STEP = 46;
/** 一屏最多排开几个房间。 */
export const FAN_MAX_VISIBLE = 8;
const FAN_MIN_VISIBLE = 2;
/** 第一项（「全部讨论…」）离按钮上沿的距离。 */
const FAN_GAP = 10;
/** 弧线半径：越往上越往屏幕里侧偏。 */
const FAN_RADIUS = 760;
const FAN_SCALE_STEP = 0.035;
const FAN_OPACITY_STEP = 0.06;

/** 按入口上方的空间算一屏排几个房间（「全部讨论…」另占一格）。 */
export function fanVisibleCount(viewport: Viewport, position: LauncherPosition): number {
  const top = launcherPoint(position, viewport).y;
  const usable = top - FAN_GAP - FAN_STEP - 16;
  return clamp(Math.floor(usable / FAN_STEP), FAN_MIN_VISIBLE, FAN_MAX_VISIBLE);
}

export interface FanSlot {
  /** 向屏幕里侧的偏移（正数；左边的入口往右、右边的往左）。 */
  inset: number;
  /** 相对按钮上沿的纵向位移（负数往上）。 */
  y: number;
  scale: number;
  opacity: number;
}

/** 紧挨按钮、固定不滚的「全部讨论…」。 */
export const FAN_ANCHOR_SLOT: FanSlot = { inset: 0, y: -FAN_GAP, scale: 1, opacity: 1 };

/**
 * 弧线上第 depth 格房间的样子：房间从 1 开始（0 是「全部讨论…」的位置）；滚动时 depth 可以是小数。
 * 越远越小、越淡；滚出一屏的两端在一格之内淡出（往下滚出去的落进「全部讨论…」之前就消失）；
 * fadeNear / fadeFar：那一端还有没排出来的房间，最外一格先淡一点，提示还能滚。
 */
export function fanSlot(depth: number, visible: number, ends: { fadeNear: boolean; fadeFar: boolean } = { fadeNear: false, fadeFar: false }): FanSlot {
  const rise = FAN_GAP + depth * FAN_STEP;
  const offset = Math.max(0, depth) * FAN_STEP;
  const inset = FAN_RADIUS - Math.sqrt(Math.max(0, FAN_RADIUS * FAN_RADIUS - offset * offset));
  const far = Math.max(0, depth - 1);
  const scale = Math.max(0.7, 1 - FAN_SCALE_STEP * far);
  let opacity = Math.max(0.45, 1 - FAN_OPACITY_STEP * far);
  opacity *= Math.min(clamp((depth - 0.4) / 0.6, 0, 1), clamp(visible + 1 - depth, 0, 1));
  if (ends.fadeNear && depth < 1.5) opacity *= clamp(0.55 + (depth - 1) * 0.9, 0, 1);
  if (ends.fadeFar && depth > visible - 0.5) opacity *= clamp(0.55 + (visible - depth) * 0.9, 0, 1);
  return { inset, y: -rise, scale, opacity: clamp(opacity, 0, 1) };
}
