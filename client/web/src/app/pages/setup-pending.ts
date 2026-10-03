import type { DoctorSummaryItem } from "./doctor-summary.js";

/**
 * 首启向导里跳过的事（需求 §4.2）：留在「我的工作」顶部当清单，做完就消失。
 * - 环境检查里没通过的项：离开检查这一步时整组覆盖写入（重新检查全部通过即清空）；
 * - 「稍后再关联」代码目录：点了就记一条，关联成功后清掉（我的工作也会按已有关联自动认为完成）。
 * 只是本机的提醒，存 localStorage；读到不认识的内容一律丢弃。
 */
export interface SetupPendingItem {
  key: DoctorSummaryItem["key"] | "mapping";
  title: string;
  detail: string;
}

const STORAGE_KEY = "suduo.setup.pending";
const KEYS: readonly SetupPendingItem["key"][] = ["codex", "model", "network", "sandbox", "runtime", "mapping"];

export function readSetupPending(): SetupPendingItem[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (item): item is SetupPendingItem =>
        typeof item === "object" &&
        item !== null &&
        KEYS.includes((item as SetupPendingItem).key) &&
        typeof (item as SetupPendingItem).title === "string" &&
        typeof (item as SetupPendingItem).detail === "string",
    );
  } catch {
    return [];
  }
}

function write(items: readonly SetupPendingItem[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // 存储不可用：这份提醒只是锦上添花，丢了不影响使用。
  }
}

/** 环境检查的结论整组替换（保留代码目录那条）。 */
export function recordEnvironmentPending(summary: readonly DoctorSummaryItem[]): void {
  const env = summary
    .filter((item) => item.status !== "ok")
    .map((item) => ({ key: item.key, title: item.title, detail: item.detail }));
  write([...env, ...readSetupPending().filter((item) => item.key === "mapping")]);
}

export function recordMappingPending(pending: boolean): void {
  const rest = readSetupPending().filter((item) => item.key !== "mapping");
  write(pending ? [...rest, { key: "mapping", title: "关联本机代码目录", detail: "还没有告诉 SuDuo 项目代码在哪里，开始会话前需要选一次。" }] : rest);
}

export function clearSetupPending(): void {
  write([]);
}
