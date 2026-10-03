import { describe, expect, it } from "vitest";
import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import type { ConversationProjection, TurnMeta } from "../src/event-projection/reducer.js";
import {
  INITIAL_TIMING,
  elapsedFor,
  lastTurnOutcomeOf,
  onLiveEvent,
  onStreamLive,
  onStreamReset,
  reconcileStopping,
  resolveStopIntent,
  stepText,
} from "../src/session/run-state.js";

let seq = 0;
function started(turnId: string, ts = 1_000): EventEnvelope<string, JsonValue> {
  seq += 1;
  return {
    schemaVersion: 1, seq, eventId: `evt-${String(seq)}`, sessionId: "s1", source: "runtime:test",
    type: "turn.started", payload: {}, threadRef: null, turnRef: { threadId: "t1", turnId }, ts,
  };
}

function projection(metas: Array<Partial<TurnMeta> & { turnId: string; status: TurnMeta["status"] }>, running: string[] = []): ConversationProjection {
  return {
    messages: [], turns: [], notices: [], runningTurnIds: running, lastSeq: 0, runtimeError: null,
    turnMeta: new Map(metas.map((meta) => [meta.turnId, { sawStart: true, startedTs: 0, endedTs: null, endedSeq: null, currentStep: null, ...meta }])),
  };
}

describe("run-state · 计时锚点只认实时边界证据（PR3）", () => {
  it("首次开页：SSE 回放阶段（边界前）到达的历史 turn.started 不建锚点 → 不显示时长", () => {
    const state = onLiveEvent(INITIAL_TIMING, started("T-old"), 5_000);
    expect(state).toBe(INITIAL_TIMING);
    expect(elapsedFor(state, "T-old", 9_000)).toBeNull();
  });

  it("stream.live 之后实时到达的 turn.started 建锚点；时长 = now - 锚点，且与事件 ts（BFF 时钟）无关", () => {
    let state = onStreamLive(INITIAL_TIMING);
    state = onLiveEvent(state, started("T1", 1), 5_000);
    expect(elapsedFor(state, "T1", 17_000)).toBe(12_000);
    expect(elapsedFor(state, "T-unknown", 17_000)).toBeNull();
    expect(elapsedFor(state, null, 17_000)).toBeNull();
    // 同一回合重复的 start 不改锚点。
    expect(onLiveEvent(state, started("T1"), 99_000)).toBe(state);
  });

  it("断线重连：error 作废边界，重连回放里的运行中回合不建锚点，直到新的 stream.live", () => {
    let state = onStreamLive(INITIAL_TIMING);
    state = onLiveEvent(state, started("T1"), 5_000);
    state = onStreamReset(state);
    expect(state.liveBoundary).toBe(false);
    // 已建的锚点保留——那一轮本页确实实时见过它开始。
    expect(elapsedFor(state, "T1", 8_000)).toBe(3_000);
    // 重连后的回放把 T2 的 start 送来：边界未到，不建。
    state = onLiveEvent(state, started("T2"), 9_000);
    expect(elapsedFor(state, "T2", 10_000)).toBeNull();
    // 新的 stream.live 之后，再实时开始的回合才计时。
    state = onStreamLive(state);
    state = onLiveEvent(state, started("T3"), 11_000);
    expect(elapsedFor(state, "T3", 12_500)).toBe(1_500);
    expect(elapsedFor(state, "T2", 12_500)).toBeNull();
  });

  it("切会话：新挂载从 INITIAL_TIMING 开始，不继承任何锚点或边界", () => {
    const previous = onLiveEvent(onStreamLive(INITIAL_TIMING), started("T1"), 1_000);
    expect(previous.anchors.size).toBe(1);
    expect(INITIAL_TIMING.anchors.size).toBe(0);
    expect(INITIAL_TIMING.liveBoundary).toBe(false);
  });
});

describe("run-state · 停止中间态（PR3）", () => {
  it("自然完成 / 被中断 / 失败三种终态都收口；运行中保持", () => {
    const stopping = { turnId: "T1" };
    expect(reconcileStopping(stopping, projection([{ turnId: "T1", status: "running" }], ["T1"]))).toBe(stopping);
    for (const status of ["completed", "interrupted", "failed"] as const) {
      expect(reconcileStopping(stopping, projection([{ turnId: "T1", status }]))).toBeNull();
    }
    expect(reconcileStopping(null, projection([]))).toBeNull();
  });

  it("迟到的 turn.interrupt-requested 不会把已终态回合拉回 stopping：投影不消费它，终态判定不变", () => {
    // 终态先到 → 收口
    const closed = reconcileStopping({ turnId: "T1" }, projection([{ turnId: "T1", status: "completed", endedSeq: 10 }]));
    expect(closed).toBeNull();
    // 随后 interrupt-requested 入账：turnMeta 不变（reducer 无该事件分支），再 reconcile 仍是 null
    expect(reconcileStopping(closed, projection([{ turnId: "T1", status: "completed", endedSeq: 10 }]))).toBeNull();
  });

  it("点停止时目标仍在跑 → interrupt；目标已结束且另有回合在跑 → mismatch，不自动中断新的一轮；都结束 → noop", () => {
    expect(resolveStopIntent("T1", projection([{ turnId: "T1", status: "running" }], ["T1"]))).toEqual({ kind: "interrupt", turnId: "T1" });
    expect(resolveStopIntent("T1", projection([{ turnId: "T1", status: "completed" }, { turnId: "T2", status: "running" }], ["T2"])))
      .toEqual({ kind: "mismatch", endedTurnId: "T1", runningTurnId: "T2" });
    expect(resolveStopIntent("T1", projection([{ turnId: "T1", status: "interrupted" }]))).toEqual({ kind: "noop", endedTurnId: "T1" });
  });
});

describe("run-state · 顶栏结局与状态行文案", () => {
  it("lastTurnOutcomeOf 取 endedSeq 最大的终态回合", () => {
    expect(lastTurnOutcomeOf(projection([]))).toBeNull();
    expect(lastTurnOutcomeOf(projection([
      { turnId: "T1", status: "failed", endedSeq: 5 },
      { turnId: "T2", status: "completed", endedSeq: 9 },
      { turnId: "T3", status: "running" },
    ], ["T3"]))).toBe("completed");
    expect(lastTurnOutcomeOf(projection([{ turnId: "T1", status: "interrupted", endedSeq: 3 }]))).toBe("interrupted");
  });

  it("stepText 把步骤说成人话", () => {
    expect(stepText(null)).toBeNull();
    expect(stepText({ title: "执行命令", detail: "pnpm test" })).toBe("正在执行 pnpm test");
    expect(stepText({ title: "执行命令", detail: "" })).toBe("正在执行命令");
    expect(stepText({ title: "更新文件", detail: "src/a.ts" })).toBe("正在更新 src/a.ts");
    expect(stepText({ title: "思考", detail: "" })).toBe("正在思考");
    expect(stepText({ title: "搜索", detail: "" })).toBe("正在调用 搜索");
  });
});
