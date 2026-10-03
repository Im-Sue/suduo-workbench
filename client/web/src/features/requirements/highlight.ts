import { useSyncExternalStore } from "react";

/**
 * 他人改动的需求在看板 / 列表上高亮约 2 秒（本人刚改的不高亮），不弹窗、不打断编辑。
 * 单独成模块：数据层（记本人修改）和实时同步（记他人修改）都用它，互不依赖。
 */
const HIGHLIGHT_MS = 2_000;
const SELF_WINDOW_MS = 4_000;
const highlighted = new Map<string, number>();
const selfChanges = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** 本人发起的修改：随后几秒内收到的同一需求事件不当作「他人改动」。 */
export function markLocalChange(requirementId: string): void {
  selfChanges.set(requirementId, Date.now() + SELF_WINDOW_MS);
}

export function markRemoteChange(requirementId: string): void {
  const selfUntil = selfChanges.get(requirementId);
  if (selfUntil !== undefined && selfUntil > Date.now()) return;
  highlightRequirement(requirementId);
}

/** 让一条需求在看板 / 列表上闪一下（他人改动，或自己刚新建的那条）。 */
export function highlightRequirement(requirementId: string): void {
  highlighted.set(requirementId, Date.now() + HIGHLIGHT_MS);
  emit();
  window.setTimeout(() => {
    const until = highlighted.get(requirementId);
    if (until !== undefined && until <= Date.now()) {
      highlighted.delete(requirementId);
      emit();
    }
  }, HIGHLIGHT_MS + 50);
}

export function useRecentlyChanged(requirementId: string): boolean {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
  const until = highlighted.get(requirementId);
  return until !== undefined && until > Date.now();
}
