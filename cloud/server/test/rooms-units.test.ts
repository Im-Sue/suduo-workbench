import { describe, expect, it } from "vitest";
import type { RoomMessageDto } from "@suduo/cloud-contracts";
import type { RoomEventDraft } from "../src/application/rooms/events.js";
import { RealtimeHub } from "../src/application/rooms/realtime-hub.js";
import { stripNulDeep } from "../src/infrastructure/rooms/sql.js";

/** 房间模块不需要数据库的单元测试：补发缓冲上限、NUL 清理。 */

function messageEvent(body: string): RoomEventDraft {
  return {
    type: "room.message",
    projectId: "project",
    roomId: "room",
    message: { id: "message", roomId: "room", body } as RoomMessageDto,
  };
}

/** 与缓冲同口径：事件（含 id / occurredAt）序列化后的 UTF-8 字节数。测试里的 id 都是一位数，大小一致。 */
function eventBytes(body: string): number {
  const probe = new RealtimeHub(1, "probe", () => new Date(0));
  return Buffer.byteLength(JSON.stringify(probe.publish(messageEvent(body))), "utf8");
}

describe("RealtimeHub 补发缓冲", () => {
  it("按条数限：超出从最旧的丢", () => {
    const hub = new RealtimeHub(3, "epoch", () => new Date(0));
    for (let index = 0; index < 5; index += 1) hub.publish(messageEvent(`第 ${index} 条`));
    expect(hub.eventsAfter(0).map((event) => event.id)).toEqual([3, 4, 5]);
  });

  it("按字节限：合计超过上限从最旧的丢；补发只给缓冲里还在的（首条不是 lastEventId+1 = 有缺口）", () => {
    const body = "回答".repeat(1_000);
    const size = eventBytes(body);
    // 能放下两条半：第三条进来时丢最旧的一条。
    const hub = new RealtimeHub(2_000, "epoch", () => new Date(0), Math.floor(size * 2.5));
    const received: number[] = [];
    hub.subscribe((event) => received.push(event.id));
    hub.publish(messageEvent(body));
    hub.publish(messageEvent(body));
    expect(hub.eventsAfter(0).map((event) => event.id)).toEqual([1, 2]);
    hub.publish(messageEvent(body));
    expect(hub.eventsAfter(0).map((event) => event.id)).toEqual([2, 3]);
    expect(hub.eventsAfter(2).map((event) => event.id)).toEqual([3]);
    // 实时推送不受缓冲上限影响。
    expect(received).toEqual([1, 2, 3]);
  });

  it("一条大事件可以挤掉多条旧的小事件", () => {
    const small = eventBytes("短");
    const big = eventBytes("回答".repeat(1_000));
    const hub = new RealtimeHub(2_000, "epoch", () => new Date(0), big + Math.floor(small * 2.5));
    for (let index = 0; index < 4; index += 1) hub.publish(messageEvent("短"));
    expect(hub.eventsAfter(0).map((event) => event.id)).toEqual([1, 2, 3, 4]);
    hub.publish(messageEvent("回答".repeat(1_000)));
    expect(hub.eventsAfter(0).map((event) => event.id)).toEqual([3, 4, 5]);
  });

  it("单条就超过字节上限：照常实时推送，缓冲清空（保持连续，补发方能从首条 id 发现缺口）", () => {
    const hub = new RealtimeHub(2_000, "epoch", () => new Date(0), 2_000);
    const received: number[] = [];
    hub.subscribe((event) => received.push(event.id));
    hub.publish(messageEvent("小"));
    hub.publish(messageEvent("大".repeat(5_000)));
    expect(received).toEqual([1, 2]);
    expect(hub.eventsAfter(0)).toEqual([]);
    hub.publish(messageEvent("小"));
    expect(hub.eventsAfter(0).map((event) => event.id)).toEqual([3]);
  });
});

describe("stripNulDeep", () => {
  it("递归去掉字符串值与对象 key 里的 NUL；其他类型原样", () => {
    expect(
      stripNulDeep({
        "ki\u0000nd": "a\u0000b",
        list: ["\u0000", 1, null, true, { "\u0000": ["x\u0000y"] }],
        clean: { ok: 1 },
      }),
    ).toEqual({ kind: "ab", list: ["", 1, null, true, { "": ["xy"] }], clean: { ok: 1 } });
    expect(stripNulDeep("\u0000\u0000")).toBe("");
    expect(stripNulDeep(42)).toBe(42);
    expect(stripNulDeep(null)).toBeNull();
  });

  it("没有 NUL 的部分不复制（同一个引用）", () => {
    const clean = { kind: "turn", nested: [{ text: "ok" }] };
    expect(stripNulDeep(clean)).toBe(clean);
    const mixed = { dirty: "a\u0000", clean };
    const result = stripNulDeep(mixed);
    expect(result).not.toBe(mixed);
    expect(result.clean).toBe(clean);
  });
});
