import { useCallback, useState } from "react";

/**
 * localStorage 记忆的 useState：界面折叠/收起等偏好跨会话保留。
 * 只用于纯 UI 偏好——凡是会触发数据请求的标识（projectId 等）
 * 仍走显式校验路径（见批次 6 与「项目不存在」的教训）。
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, (next: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T | ((previous: T) => T)) => {
      setValue((previous) => {
        const resolved =
          typeof next === "function"
            ? (next as (previous: T) => T)(previous)
            : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // 存储满/隐私模式：静默降级为会话内记忆。
        }
        return resolved;
      });
    },
    [key],
  );
  return [value, set];
}

/**
 * 记忆的「几选一」：读到不在候选里的值（旧版本写入、手工改过、存储损坏）就用默认值。
 * 凡是会进请求参数或界面文案的偏好都用它，不直接用 usePersistentState。
 */
export function usePersistentChoice<T extends string | number>(
  key: string,
  allowed: readonly T[],
  initial: T,
): [T, (next: T) => void] {
  const [stored, setStored] = usePersistentState<unknown>(key, initial);
  const value = allowed.includes(stored as T) ? (stored as T) : initial;
  return [value, setStored as (next: T) => void];
}
