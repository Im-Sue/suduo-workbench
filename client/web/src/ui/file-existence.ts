import { useContext, useEffect, useSyncExternalStore } from "react";
import { MarkdownLinkContext } from "./markdown-link-context.js";

/**
 * 会话回答里的路径要不要变成链接：先问本机「这个文件在不在」（需求 R2）。
 * - 同一会话页内按路径缓存；同一轮渲染里冒出来的路径攒成一批（最多 200 条）一次问完；
 * - 不存在的结果 15 秒后作废：Codex 可能刚说完就建了这个文件，重新渲染时再问一次；
 * - 查询失败当作「不知道」，只显示文字，过一会儿可重试。
 */
export type FileExistence = "exists" | "missing" | "unknown";

const BATCH_LIMIT = 200;
const MISSING_TTL_MS = 15_000;
const FAILURE_RETRY_MS = 30_000;

type Entry =
  | { state: "pending" }
  | { state: "exists" }
  | { state: "missing"; at: number }
  | { state: "failed"; at: number };

export class FileExistenceStore {
  private readonly entries = new Map<string, Entry>();
  private readonly queued = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private scheduled = false;
  private version = 0;

  constructor(
    private readonly check: (paths: readonly string[]) => Promise<readonly string[]>,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** useSyncExternalStore 的快照：任何结果变化都换一个版本号。 */
  snapshot = (): number => this.version;

  get(path: string): FileExistence {
    const entry = this.entries.get(path);
    if (entry?.state === "exists") return "exists";
    if (entry?.state === "missing") return "missing";
    return "unknown";
  }

  /** 需要知道这个路径在不在：没问过、或上次的「不存在 / 失败」已过期，就排进下一批。 */
  request(path: string): void {
    const entry = this.entries.get(path);
    const now = this.now();
    if (entry !== undefined) {
      if (entry.state === "exists" || entry.state === "pending") return;
      if (entry.state === "missing" && now - entry.at < MISSING_TTL_MS) return;
      if (entry.state === "failed" && now - entry.at < FAILURE_RETRY_MS) return;
    }
    this.queued.add(path);
    this.entries.set(path, { state: "pending" });
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => void this.flush());
    }
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    const all = [...this.queued];
    this.queued.clear();
    for (let start = 0; start < all.length; start += BATCH_LIMIT) {
      const batch = all.slice(start, start + BATCH_LIMIT);
      try {
        const found = new Set(await this.check(batch));
        const at = this.now();
        for (const path of batch) this.entries.set(path, found.has(path) ? { state: "exists" } : { state: "missing", at });
      } catch {
        const at = this.now();
        for (const path of batch) this.entries.set(path, { state: "failed", at });
      }
      this.version += 1;
      for (const listener of this.listeners) listener();
    }
  }
}

const NO_STORE = { subscribe: () => () => undefined, snapshot: () => 0 };

/** 这个项目内相对路径在不在；null = 当前上下文不认文件路径（没有提供方，或不是候选）。 */
export function useFileExistence(path: string | null): FileExistence | null {
  const { files } = useContext(MarkdownLinkContext);
  const source = files ?? NO_STORE;
  useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot);
  // 每次渲染都问一下（命中缓存时只是一次 Map 查找）：「不存在」过期后，回答再渲染时能重新确认。
  useEffect(() => {
    if (files !== undefined && path !== null) files.request(path);
  });
  if (files === undefined || path === null) return null;
  return files.get(path);
}
