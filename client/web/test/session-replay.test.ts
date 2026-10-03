import { readFileSync } from "node:fs";
import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import {
  BACKFILL_LATEST_ONLY_EVENT_TYPES,
  BACKFILL_OMITTED_EVENT_TYPES,
} from "@suduo/client-contracts";
import { describe, expect, it } from "vitest";
import { projectEvents } from "../src/event-projection/reducer.js";

/**
 * P3 退出条件「回放真实会话录制无丢字」（技术设计 §10.1）。
 *
 * 夹具是本机服务经 Codex 0.143 真实跑出的三个会话（SSE 全量，含逐字增量；路径已脱敏）：
 * - explain：只读文件、三段说明（多段文字与步骤交错）；
 * - fix-and-test：改文件（经确认）、跑测试、一句话总结；
 * - feature-plan：先列计划、再实现、补测试、跑测试、列表总结（计划更新、多次改动）。
 *
 * 「无丢字」的判据：
 * 1）实时回放（逐条喂事件）时，每来一段增量，界面上的这段文字恰好等于到此为止的增量拼接——
 *    只看最终结果不够：item.completed 会把全文补回来，把直播中途丢字的投影也放过去；
 * 2）刷新后回放（回填接口：去掉逐字增量、快照只留最后一条）时，与 Codex 给出的全文完全一致。
 */
type Envelope = EventEnvelope<string, JsonValue>;

const FIXTURES = ["explain", "fix-and-test", "feature-plan"] as const;

function load(name: string): Envelope[] {
  const file = new URL(`./fixtures/session-replay/${name}.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, "utf8")) as { events: Envelope[] }).events;
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Codex 最终给出的每条回复全文（按 itemId）。 */
function completedMessages(events: readonly Envelope[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "item.completed") continue;
    const item = asObject(asObject(event.payload)?.["item"]);
    if (item?.["type"] === "agentMessage" && typeof item["id"] === "string" && typeof item["text"] === "string") {
      result.set(item["id"], item["text"]);
    }
  }
  return result;
}

/** 界面上每段回复文字（按 itemId）。 */
function projectedTexts(events: readonly Envelope[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of projectEvents(events).timeline) {
    if (entry.kind !== "turn") continue;
    for (const block of entry.turn.blocks) {
      if (block.kind === "text") result.set(block.id.replace(/^text:/, ""), block.text);
    }
  }
  return result;
}

/** 回填接口的口径：逐字增量不回；只关心最新值的快照只留最后一条。 */
function asBackfill(events: readonly Envelope[]): Envelope[] {
  const omitted = new Set<string>(BACKFILL_OMITTED_EVENT_TYPES);
  const latestOnly = new Set<string>(BACKFILL_LATEST_ONLY_EVENT_TYPES);
  const lastSeq = new Map<string, number>();
  for (const event of events) if (latestOnly.has(event.type)) lastSeq.set(event.type, event.seq);
  return events.filter((event) => !omitted.has(event.type) && (!latestOnly.has(event.type) || lastSeq.get(event.type) === event.seq));
}

describe.each(FIXTURES)("真实会话回放 · %s", (name) => {
  const events = load(name);
  const expected = completedMessages(events);

  it("录制完整：有回复、有逐字增量、回合正常结束", () => {
    expect(expected.size).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "message.delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("实时回放：每来一段增量，界面上的这段文字就恰好是到此为止的增量拼接（一字不丢、不多），最后与全文一致", () => {
    const streamed = new Map<string, string>();
    let checks = 0;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.type !== "message.delta") continue;
      const payload = asObject(event.payload);
      const itemId = payload?.["itemId"];
      const delta = payload?.["text"];
      if (typeof itemId !== "string" || typeof delta !== "string") continue;
      streamed.set(itemId, (streamed.get(itemId) ?? "") + delta);
      const shown = projectedTexts(events.slice(0, index + 1)).get(itemId) ?? "";
      expect(shown, `${itemId} 在第 ${index} 条事件（增量）后`).toBe(streamed.get(itemId));
      checks += 1;
    }
    // 每条最终回复都经历过增量（不然这条检查就是空转）。
    expect(checks).toBeGreaterThan(0);
    expect([...expected.keys()].filter((itemId) => !streamed.has(itemId))).toEqual([]);
    const final = projectedTexts(events);
    for (const [itemId, text] of expected) expect(final.get(itemId), itemId).toBe(text);
  });

  it("刷新后回放（回填口径）：与全文一字不差", () => {
    const final = projectedTexts(asBackfill(events));
    for (const [itemId, text] of expected) expect(final.get(itemId), itemId).toBe(text);
  });

  it("夹具完整性：逐字增量拼起来就是 Codex 给出的全文（录制没有缺段）", () => {
    const joined = new Map<string, string>();
    for (const event of events) {
      if (event.type !== "message.delta") continue;
      const payload = asObject(event.payload);
      const itemId = payload?.["itemId"];
      const delta = payload?.["text"];
      if (typeof itemId === "string" && typeof delta === "string") joined.set(itemId, (joined.get(itemId) ?? "") + delta);
    }
    // 每条最终回复都要有增量（不然这条检查就是空转）。
    expect([...expected.keys()].filter((itemId) => !joined.has(itemId))).toEqual([]);
    for (const [itemId, text] of expected) expect(joined.get(itemId), itemId).toBe(text);
  });
});
