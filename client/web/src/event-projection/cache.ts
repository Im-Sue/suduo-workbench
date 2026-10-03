import { BACKFILL_OMITTED_EVENT_TYPES } from "@suduo/client-contracts";
import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";

/**
 * 会话事件的 localStorage 缓存。
 * 截断时优先对齐 turn 边界（consult 结论 Q1），
 * 避免回放从 turn 中段开始导致工作过程卡状态失真。
 */

const MAX_EVENTS = 2000;
/**
 * 序列化字符预算。localStorage 配额通常 ~5MB（UTF-16），事件账本里的
 * 命令输出等大块 payload 只按条数截断压不住体积——超配额的 setItem 会
 * 抛 QuotaExceededError（2026-07-23 发消息白屏事故的根因），必须按体积再截。
 */
const MAX_CHARS = 1_500_000;
/** 与服务端回填同一口径：增量事件的最终态可以由 item.completed 重建，缓存放不下时先丢它们。 */
const DELTA_EVENT_TYPES = new Set<string>(BACKFILL_OMITTED_EVENT_TYPES);

function cacheStartKey(sessionId: string): string {
  return `suduo.cacheStart.${sessionId}`;
}

export function loadEventCache(
  sessionId: string,
): EventEnvelope<string, JsonValue>[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(`suduo.events.${sessionId}`) ?? "[]",
    ) as EventEnvelope<string, JsonValue>[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 缓存首条账本序号；用于判断缓存是否缺少历史头部。 */
export function loadEventCacheStart(sessionId: string): number | null {
  try {
    const value = localStorage.getItem(cacheStartKey(sessionId));
    if (value === null) {
      return null;
    }
    const start = Number(value);
    return Number.isSafeInteger(start) && start >= 0 && String(start) === value
      ? start
      : null;
  } catch {
    return null;
  }
}

/** 截断后尽量从 turn/消息边界开始，避免回放从 turn 中段开始。 */
function alignToBoundary(
  slice: EventEnvelope<string, JsonValue>[],
): EventEnvelope<string, JsonValue>[] {
  const boundary = slice.findIndex(
    (event) =>
      event.type === "turn.started" || event.type === "message.submitted",
  );
  return boundary > 0 ? slice.slice(boundary) : slice;
}

function discardDeltaEvents(
  events: EventEnvelope<string, JsonValue>[],
): EventEnvelope<string, JsonValue>[] {
  return events.filter((event) => !DELTA_EVENT_TYPES.has(event.type));
}

/**
 * 缓存截断先丢可由 item.completed 重建的流式增量，再保留原有边界对齐策略。
 */
function truncateForEventLimit(
  events: EventEnvelope<string, JsonValue>[],
): EventEnvelope<string, JsonValue>[] {
  if (events.length <= MAX_EVENTS) {
    return events;
  }
  const compact = discardDeltaEvents(events);
  const candidate = compact.length < events.length ? compact : events;
  return candidate.length > MAX_EVENTS
    ? alignToBoundary(candidate.slice(-MAX_EVENTS))
    : candidate;
}

function discardDeltasBeforeShrinking(
  events: EventEnvelope<string, JsonValue>[],
): EventEnvelope<string, JsonValue>[] | null {
  const compact = discardDeltaEvents(events);
  return compact.length < events.length ? compact : null;
}

export function saveEventCache(
  sessionId: string,
  events: EventEnvelope<string, JsonValue>[],
): void {
  let slice = truncateForEventLimit(events);
  // 缓存只是回放加速，服务端事件账本才是真相源：存不下就丢旧事件，绝不向上抛。
  for (;;) {
    const serialized = JSON.stringify(slice);
    if (serialized.length > MAX_CHARS && slice.length > 8) {
      const compact = discardDeltasBeforeShrinking(slice);
      if (compact) {
        slice = compact;
        continue;
      }
      slice = alignToBoundary(slice.slice(Math.floor(slice.length / 2)));
      continue;
    }
    try {
      localStorage.setItem(`suduo.events.${sessionId}`, serialized);
      localStorage.setItem(
        `suduo.cursor.${sessionId}`,
        String(slice.at(-1)?.seq ?? 0),
      );
      localStorage.setItem(
        cacheStartKey(sessionId),
        String(slice.at(0)?.seq ?? 0),
      );
      return;
    } catch {
      if (slice.length <= 8) {
        // 连极小分片都写不进（配额被占满/隐私模式）：清掉本会话旧缓存释放配额，
        // 下次启动从服务端全量回放，不丢任何数据。
        try {
          localStorage.removeItem(`suduo.events.${sessionId}`);
          localStorage.removeItem(`suduo.cursor.${sessionId}`);
          localStorage.removeItem(cacheStartKey(sessionId));
        } catch {
          // 忽略：存储完全不可用时降级为纯内存。
        }
        return;
      }
      const compact = discardDeltasBeforeShrinking(slice);
      if (compact) {
        slice = compact;
        continue;
      }
      slice = alignToBoundary(slice.slice(Math.floor(slice.length / 2)));
    }
  }
}
