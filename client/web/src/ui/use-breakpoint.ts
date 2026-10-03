import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * 跨越视口断点时应用一次默认折叠。
 *
 * **刻意不在挂载时应用**：那会在每次刷新时覆盖用户显式的折叠偏好。
 * 只在 `change` 事件（即真正跨越断点）时给出建议值，用户随后仍可自由 toggle——
 * 窗口尺寸决定的是「默认怎么摆」，不是「用户不许改」。
 */
export function useCollapseOnBreakpoint(
  query: string,
  apply: (matches: boolean) => void,
): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => {
      applyRef.current(event.matches);
    };
    list.addEventListener("change", onChange);
    return () => {
      list.removeEventListener("change", onChange);
    };
  }, [query]);
}

/** 会话页四区的让位顺序：先收工作区，再收会话列表，主导航保持图标条。 */
export const WORKSPACE_COLLAPSE_QUERY = "(max-width: 1400px)";
export const SESSION_LIST_COLLAPSE_QUERY = "(max-width: 1100px)";

/** 订阅一个媒体查询的当前结果（没有 matchMedia 的环境视为不匹配）。 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

/** 会话页检查面板：宽于此并排，窄于此变成浮层（需求 §4.5）。 */
export const INSPECTOR_SIDE_BY_SIDE_QUERY = "(min-width: 1280px)";
