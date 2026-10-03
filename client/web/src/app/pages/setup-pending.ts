import type { DoctorSummaryItem } from "./doctor-summary.js";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";

/**
 * 首启向导里跳过的事（需求 §4.2）：留在「我的工作」顶部当清单，做完就消失。
 * - 环境检查里没通过的项：离开检查这一步时整组覆盖写入（重新检查全部通过即清空）；
 * - 「稍后再关联」代码目录：点了就记一条，关联成功后清掉（我的工作也会按已有关联自动认为完成）。
 * 只是本机的提醒，存 localStorage；读到不认识的内容一律丢弃。
 *
 * 存的是类型（key）而不是成句文字：各项标题、代码目录那条的说明在读取时按当时的界面语言从字典取，
 * 切换语言后旧提醒跟着变。环境检查项的 detail 是检查当时的结论快照，照存照显。
 * 旧版存的是 `{ key, title, detail }`：照样认，标题与代码目录那条的说明同样按 key 重新取，存的 title 不再使用。
 */
export interface SetupPendingItem {
  key: DoctorSummaryItem["key"] | "mapping";
  title: string;
  detail: string;
}

/** localStorage 里的一条：环境检查项带检查当时的结论，代码目录那条只有 key。 */
type StoredPendingItem = { key: "mapping" } | { key: DoctorSummaryItem["key"]; detail: string };

const STORAGE_KEY = "suduo.setup.pending";
const KEYS: readonly SetupPendingItem["key"][] = ["codex", "model", "network", "sandbox", "runtime", "mapping"];

function readStored(): StoredPendingItem[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item: unknown): StoredPendingItem[] => {
      if (typeof item !== "object" || item === null) return [];
      const { key, detail } = item as { key?: unknown; detail?: unknown };
      if (key === "mapping") return [{ key }];
      if (!KEYS.includes(key as SetupPendingItem["key"]) || typeof detail !== "string") return [];
      return [{ key: key as DoctorSummaryItem["key"], detail }];
    });
  } catch {
    return [];
  }
}

/** 文字按调用时的界面语言取；组件里传入 useT() 拿到的字典。 */
export function readSetupPending(t: Messages = messagesFor(currentLocale())): SetupPendingItem[] {
  return readStored().map((item) =>
    item.key === "mapping"
      ? { key: item.key, title: t.setup.pending.mappingTitle, detail: t.setup.pending.mappingDetail }
      : { key: item.key, title: t.setup.doctor.titles[item.key], detail: item.detail },
  );
}

function write(items: readonly StoredPendingItem[]): void {
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
    .map((item): StoredPendingItem => ({ key: item.key, detail: item.detail }));
  write([...env, ...readStored().filter((item) => item.key === "mapping")]);
}

export function recordMappingPending(pending: boolean): void {
  const rest = readStored().filter((item) => item.key !== "mapping");
  write(pending ? [...rest, { key: "mapping" }] : rest);
}

export function clearSetupPending(): void {
  write([]);
}
