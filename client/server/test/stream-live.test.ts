import { describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  EventEnvelope,
  JsonValue,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnInput,
  StartTurnResult,
} from "@suduo/client-contracts";
import { formatSseControlFrame, formatSseEvent } from "../src/application/event-stream.js";
import {
  SseReader,
  createMinimalHttpContext,
  createProjectAndSession,
} from "./helpers/minimal-http-context.js";

/**
 * PR3 `stream.live` 传输控制帧（技术设计 §四.5 计时基准，物化前协商 r2/r3）：
 * - 序列化：控制帧不能带 `id:` 行，账本事件的字节逐字不变；
 * - 游标：控制帧之后断线，浏览器记住的 Last-Event-ID 仍是最后一条账本事件的 seq；
 *   自动重连按真实形状（旧 `?after=` query + 新 `Last-Event-ID` header）从该 seq 之后续传。
 */
describe("stream.live 序列化", () => {
  it("控制帧只有 event 与 data 两行，没有 id 行；账本事件的序列化字节与改动前逐字相同", () => {
    expect(formatSseControlFrame({ kind: "control", type: "stream.live" })).toBe("event: stream.live\ndata: {}\n\n");
    expect(formatSseControlFrame({ kind: "control", type: "stream.live" })).not.toContain("id:");

    const event: EventEnvelope<string, JsonValue> = {
      schemaVersion: 1,
      seq: 7,
      eventId: "evt-7",
      sessionId: "s1",
      source: "runtime:test",
      type: "turn.started",
      payload: { threadId: "t1", turn: { id: "turn-1" } },
      threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "t1" },
      turnRef: { threadId: "t1", turnId: "turn-1" },
      ts: 1_700_000_000_000,
    };
    // 改动前 formatSseEvent 的输出（golden）：id / event / data 三行 + 空行。
    const golden =
      "id: 7\nevent: turn.started\ndata: " +
      "{\"schemaVersion\":1,\"seq\":7,\"eventId\":\"evt-7\",\"sessionId\":\"s1\",\"source\":\"runtime:test\",\"type\":\"turn.started\",\"payload\":{\"threadId\":\"t1\",\"turn\":{\"id\":\"turn-1\"}},\"threadRef\":{\"runtimeId\":\"codex-local\",\"runtimeKind\":\"codex\",\"threadId\":\"t1\"},\"turnRef\":{\"threadId\":\"t1\",\"turnId\":\"turn-1\"},\"ts\":1700000000000}" +
      "\n\n";
    expect(formatSseEvent(event)).toBe(golden);
  });
});

describe("stream.live 与续传游标（真实 HTTP + 自动重连形状）", () => {
  it("控制帧不更新 Last-Event-ID；旧 query + 新 header 重连时从 header 续传，且再次收到 stream.live", async () => {
    const context = createMinimalHttpContext(new IdleRuntime());
    let firstReader: SseReader | null = null;
    let secondReader: SseReader | null = null;
    try {
      const base = await context.listen();
      const { sessionId } = await createProjectAndSession(base, context.projectRoot);
      const append = (dedupeKey: string) =>
        context.ledger.append({ sessionId, sessionThreadId: null, event: runtimeEvent("message.delta", dedupeKey) });
      const seq1 = append("d1").seq;
      append("d2");
      const seq3 = append("d3").seq;

      // 首次打开：前端固定带 ?after=<缓存尾>，这里模拟空缓存 after=0。
      const url = `${base}/api/v1/sessions/${sessionId}/events?after=0`;
      const first = await fetch(url);
      expect(first.headers.get("content-type")).toContain("text/event-stream");
      firstReader = new SseReader(first);
      const frames = await firstReader.readUntil((frame) => frame.kind === "control");
      expect(frames.map((frame) => (frame.kind === "event" ? frame.event.seq : frame.type))).toEqual([seq1, seq1 + 1, seq3, "stream.live"]);
      // 浏览器规则：控制帧没有 id 行，记住的仍是最后一条账本事件。
      expect(frames.at(-1)).toMatchObject({ kind: "control", id: null });
      expect(firstReader.lastEventId).toBe(String(seq3));
      // 反例守卫：整条流里不存在 `id: undefined` / 空 id。
      for (const raw of firstReader.rawFrames) {
        expect(raw).not.toMatch(/^id: undefined$/m);
        expect(raw).not.toMatch(/^id:\s*$/m);
      }
      // 断线（浏览器会随后自动重连）。
      await firstReader.cancel();

      const seq4 = append("d4").seq;
      // 自动重连的真实形状：同一 URL（旧 query after=0）+ Last-Event-ID: 3。
      const second = await fetch(url, { headers: { "last-event-id": String(seq3) } });
      secondReader = new SseReader(second);
      const resumed = await secondReader.readUntil((frame) => frame.kind === "control");
      expect(resumed.map((frame) => (frame.kind === "event" ? frame.event.seq : frame.type))).toEqual([seq4, "stream.live"]);

      // header 非法时回落 query：从 after=0 整段重放。
      const fallback = await fetch(url, { headers: { "last-event-id": "not-a-cursor" } });
      const fallbackReader = new SseReader(fallback);
      try {
        const replayed = await fallbackReader.readUntil((frame) => frame.kind === "control");
        expect(replayed.filter((frame) => frame.kind === "event").map((frame) => (frame as { event: { seq: number } }).event.seq)).toEqual([seq1, seq1 + 1, seq3, seq4]);
      } finally {
        await fallbackReader.cancel();
      }
    } finally {
      await firstReader?.cancel();
      await secondReader?.cancel();
      await context.close();
    }
  }, 30_000);
});

function runtimeEvent(type: string, dedupeKey: string): RuntimeEventDraft {
  return {
    source: "runtime:test",
    type,
    payload: { text: dedupeKey },
    threadRef: null,
    turnRef: null,
    ts: Date.now(),
    dedupeKey,
  };
}

class IdleRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  async startThread(): Promise<StartThreadResult> {
    const thread = { threadRef: { runtimeId: this.runtimeId, runtimeKind: this.runtimeKind, threadId: "thread-1" }, role: "primary" as const, metadata: {} };
    return { primaryThread: thread, threads: [thread] };
  }
  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    return { turnRef: { threadId: input.threadRef.threadId, turnId: "turn-1" }, acceptedAt: Date.now() };
  }
  async approve(): Promise<ApproveResult> {
    return { acknowledged: true };
  }
  async interrupt(): Promise<void> {
    return undefined;
  }
  async *subscribe(): AsyncIterable<RuntimeEventDraft> {
    yield* [];
  }
}
