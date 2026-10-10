import type { SuDuoDesktopBridge } from "@suduo/client-contracts";

/**
 * 桌面应用（Electron 外壳）的桥：preload 只在安装版的页面里放 window.suDuoDesktop。浏览器里打开没有它，
 * 调用方一律按「没有」处理（设置里不显示「桌面应用」分组、通知点了只聚焦页面）。
 */
export function desktopBridge(): SuDuoDesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { suDuoDesktop?: Partial<SuDuoDesktopBridge> }).suDuoDesktop;
  return bridge !== undefined && typeof bridge.info === "function" ? (bridge as SuDuoDesktopBridge) : null;
}
