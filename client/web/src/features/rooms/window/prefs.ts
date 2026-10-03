import { parseLauncherPosition, parseRect, type LauncherPosition, type Rect } from "./geometry.js";

/**
 * 悬浮窗口与悬浮入口的个人偏好（需求 R3）：只记在本浏览器，不上服务器。
 * 存储不可用（隐私模式、配额满、被禁用）或读到坏数据时一律当没记过，界面照常用默认值。
 */
export const WINDOW_RECT_KEY = "suduo.roomWindow.rect";
export const SIDE_WIDTH_KEY = "suduo.roomWindow.sideWidth";
export const LAUNCHER_POSITION_KEY = "suduo.roomLauncher.position";

function read<T>(key: string, parse: (raw: unknown) => T | null): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不下就只在本次打开期间有效。
  }
}

export const readWindowRect = (): Rect | null => read(WINDOW_RECT_KEY, parseRect);
export const writeWindowRect = (rect: Rect): void => write(WINDOW_RECT_KEY, rect);

export const readSideWidth = (): number | null =>
  read(SIDE_WIDTH_KEY, (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null));
export const writeSideWidth = (width: number): void => write(SIDE_WIDTH_KEY, Math.round(width));

export const readLauncherPosition = (): LauncherPosition | null => read(LAUNCHER_POSITION_KEY, parseLauncherPosition);
export const writeLauncherPosition = (position: LauncherPosition): void => write(LAUNCHER_POSITION_KEY, position);
