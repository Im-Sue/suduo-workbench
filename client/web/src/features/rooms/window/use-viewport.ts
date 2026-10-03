import { useSyncExternalStore } from "react";
import type { Viewport } from "./geometry.js";

/** 浏览器可视区尺寸：窗口缩放时更新（同尺寸返回同一个对象，不引起多余渲染）。 */
const FALLBACK: Viewport = { width: 1280, height: 800 };
let cached: Viewport = FALLBACK;

function snapshot(): Viewport {
  if (typeof window === "undefined") return FALLBACK;
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (width !== cached.width || height !== cached.height) cached = { width, height };
  return cached;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, snapshot, () => FALLBACK);
}

/** 非渲染场景（按下时取起点）直接读当前值。 */
export function currentViewport(): Viewport {
  return snapshot();
}
