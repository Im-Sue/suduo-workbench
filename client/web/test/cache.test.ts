import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import {
  loadEventCache,
  loadEventCacheStart,
  saveEventCache,
} from "../src/event-projection/cache.js";
import { projectEvents } from "../src/event-projection/reducer.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function event(
  seq: number,
  type: string,
  payload: JsonValue,
): EventEnvelope<string, JsonValue> {
  return {
    schemaVersion: 1,
    seq,
    eventId: `event-${String(seq)}`,
    sessionId: "session-cache",
    source: "test",
    type,
    payload,
    threadRef: null,
    turnRef: null,
    ts: seq,
  };
}

describe("事件缓存截断与回补", () => {
  it("截断后记录实际缓存首序号，供下次补齐头部", () => {
    const events = Array.from({ length: 2_100 }, (_, index) =>
      event(index + 1, "message.submitted", {
        content: [{ type: "text", text: `用户消息 ${String(index + 1)}` }],
      }),
    );

    saveEventCache("session-cache", events);

    expect(loadEventCacheStart("session-cache")).toBe(101);
    expect(loadEventCache("session-cache").at(0)?.seq).toBe(101);
  });

  it("超条数时优先移除 delta，保留更多可见消息事件", () => {
    const messages = Array.from({ length: 1_001 }, (_, index) =>
      event(index + 1, "message.submitted", {
        content: [{ type: "text", text: `消息 ${String(index + 1)}` }],
      }),
    );
    const deltas = Array.from({ length: 1_000 }, (_, index) =>
      event(index + 1_002, "message.delta", { text: `增量 ${String(index)}` }),
    );

    saveEventCache("session-cache", [...messages, ...deltas]);

    const cached = loadEventCache("session-cache");
    expect(cached).toHaveLength(1_001);
    expect(cached.every((item) => item.type !== "message.delta")).toBe(true);
    expect(loadEventCacheStart("session-cache")).toBe(1);
  });

  it("2100 条事件截断后补头可重建完整用户历史", () => {
    const all = Array.from({ length: 2_100 }, (_, index) =>
      event(index + 1, "message.submitted", {
        content: [{ type: "text", text: `历史 ${String(index + 1)}` }],
      }),
    );
    saveEventCache("session-cache", all);
    const cached = loadEventCache("session-cache");
    const start = loadEventCacheStart("session-cache");
    expect(start).toBe(101);

    const backfill = all.filter((item) => item.seq < (start ?? 0));
    const rebuilt = [...backfill, ...cached].sort((left, right) => left.seq - right.seq);
    const projection = projectEvents(rebuilt);

    expect(rebuilt).toHaveLength(2_100);
    expect(projection.messages).toHaveLength(2_100);
    expect(projection.messages[0]).toMatchObject({ role: "user", text: "历史 1" });
    expect(projection.messages.at(-1)).toMatchObject({
      role: "user",
      text: "历史 2100",
    });
  });
});
