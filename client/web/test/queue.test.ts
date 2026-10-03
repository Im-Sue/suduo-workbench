import { describe, expect, it } from "vitest";
import { ApiClientError } from "../src/api/client.js";
import type { ConversationProjection, TurnMeta } from "../src/event-projection/reducer.js";
import {
  ATTRIBUTION_DEADLINE_MS,
  beginDispatch,
  buildMessageContent,
  canDispatch,
  classifySendFailure,
  emptyQueue,
  enqueue,
  loadQueue,
  onSendAccepted,
  onSendRejected,
  onSendUncertain,
  pause,
  reconcile,
  removeItem,
  resume,
  saveQueue,
  takeItem,
  updateItem,
  type QueueItem,
  type QueueState,
} from "../src/session/queue.js";

const item = (id: string, text = id): QueueItem => ({ id, text, attachmentIds: [] });

function projection(input: {
  running?: string[];
  meta?: Array<Partial<TurnMeta> & { turnId: string; status: TurnMeta["status"] }>;
  users?: Array<{ clientTurnId: string; turnId: string | null }>;
  lastSeq?: number;
}): ConversationProjection {
  return {
    messages: (input.users ?? []).map((user, index) => ({
      id: `u${String(index)}`, role: "user" as const, text: "", ts: index, turnId: user.turnId, clientTurnId: user.clientTurnId,
      attribution: "submitted" as const, interruptedNote: false, attachments: [], skills: [],
    })),
    turns: [], notices: [], runningTurnIds: input.running ?? [], lastSeq: input.lastSeq ?? 0, runtimeError: null,
    turnMeta: new Map((input.meta ?? []).map((meta) => [meta.turnId, { sawStart: true, startedTs: 0, endedTs: null, endedSeq: null, currentStep: null, ...meta }])),
  };
}

/** 先对过一次账（基线 seenSeq），模拟挂载后的常态。 */
function baselined(state: QueueState, lastSeq = 0): QueueState {
  return reconcile(state, projection({ lastSeq }), 0);
}

class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

describe("queue 状态机（PR5，spec 第 7 项 9 条）", () => {
  it("1. 出队仅在无运行回合且 awaitingTurnId=null（inflight 为空）", () => {
    let state = baselined(enqueue(emptyQueue(), item("a")));
    expect(state.status).toBe("waiting");
    expect(canDispatch(state, projection({ running: ["T0"] }))).toBe(false);
    expect(canDispatch(state, projection({}))).toBe(true);
    state = beginDispatch(state, 5);
    expect(state.status).toBe("dispatch");
    expect(state.inflight).toMatchObject({ item: { id: "a" }, dequeueSeq: 5, awaitingTurnId: null });
    // 在途未落定：即使没有回合在跑也不再出队。
    expect(canDispatch({ ...state, status: "waiting" }, projection({}))).toBe(false);
  });

  it("2. 只认 awaitingTurnId 的终态，且 endedSeq > dequeueSeq 才前进；别的回合终态不算", () => {
    let state = beginDispatch(baselined(enqueue(enqueue(emptyQueue(), item("a")), item("b"))), 10);
    state = onSendAccepted(state, "c-a", 1_000);
    // 归属解析：c-a 落进 T1
    state = reconcile(state, projection({ users: [{ clientTurnId: "c-a", turnId: "T1" }], meta: [{ turnId: "T1", status: "running" }], running: ["T1"], lastSeq: 12 }), 1_500);
    expect(state.inflight?.awaitingTurnId).toBe("T1");
    // 别的回合 T9 完成：不前进
    state = reconcile(state, projection({ users: [{ clientTurnId: "c-a", turnId: "T1" }], meta: [{ turnId: "T1", status: "running" }, { turnId: "T9", status: "completed", endedSeq: 13 }], running: ["T1"], lastSeq: 13 }), 2_000);
    expect(state.inflight?.awaitingTurnId).toBe("T1");
    expect(state.status).toBe("dispatch");
    // T1 完成且 endedSeq(14) > dequeueSeq(10)：前进，队列还有 b → waiting
    state = reconcile(state, projection({ users: [{ clientTurnId: "c-a", turnId: "T1" }], meta: [{ turnId: "T1", status: "completed", endedSeq: 14 }], lastSeq: 14 }), 2_500);
    expect(state.inflight).toBeNull();
    expect(state.status).toBe("waiting");
    expect(state.items.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("3. 回放旧终态（endedSeq <= dequeueSeq）不推进", () => {
    let state = onSendAccepted(beginDispatch(baselined(enqueue(emptyQueue(), item("a"))), 20), "c-a", 0);
    state = reconcile(state, projection({ users: [{ clientTurnId: "c-a", turnId: "T1" }], meta: [{ turnId: "T1", status: "completed", endedSeq: 15 }], lastSeq: 21 }), 100);
    expect(state.inflight?.awaitingTurnId).toBe("T1");
    expect(state.status).toBe("dispatch");
  });

  it("4. 刷新恢复必为 paused（理由 restored），且不清空；无项则 idle", () => {
    const storage = new MemoryStorage();
    saveQueue("s1", baselined(enqueue(emptyQueue(), item("a"))), storage);
    const restored = loadQueue("s1", storage);
    expect(restored).toMatchObject({ status: "paused", pausedReason: "restored", inflight: null, seenSeq: null });
    expect(restored.items.map((entry) => entry.id)).toEqual(["a"]);
    saveQueue("s1", emptyQueue(), storage);
    expect(loadQueue("s1", storage).status).toBe("idle");
    expect(loadQueue("missing", storage).items).toEqual([]);
  });

  it("5. 切会话不丢项：按 sessionId 各存各的，切回时是 paused", () => {
    const storage = new MemoryStorage();
    saveQueue("A", baselined(enqueue(emptyQueue(), item("a"))), storage);
    saveQueue("B", baselined(enqueue(emptyQueue(), item("b"))), storage);
    expect(loadQueue("A", storage).items.map((entry) => entry.text)).toEqual(["a"]);
    expect(loadQueue("B", storage).items.map((entry) => entry.text)).toEqual(["b"]);
    expect(loadQueue("A", storage).status).toBe("paused");
  });

  it("6. 停止瞬间即 paused（不等完成事件）；在途项仍继续对账但不取下一项", () => {
    let state = onSendAccepted(beginDispatch(baselined(enqueue(enqueue(emptyQueue(), item("a")), item("b"))), 0), "c-a", 0);
    state = pause(state, "user_stop");
    expect(state).toMatchObject({ status: "paused", pausedReason: "user_stop" });
    expect(state.inflight).not.toBeNull();
    state = reconcile(state, projection({ users: [{ clientTurnId: "c-a", turnId: "T1" }], meta: [{ turnId: "T1", status: "completed", endedSeq: 3 }], lastSeq: 3 }), 100);
    expect(state.inflight).toBeNull();
    expect(state.status).toBe("paused");
    expect(canDispatch(state, projection({}))).toBe(false);
  });

  it("7. 证实未受理：项回队首并 paused（send_rejected）；恢复后可重发", () => {
    let state = beginDispatch(baselined(enqueue(enqueue(emptyQueue(), item("a")), item("b"))), 0);
    state = onSendRejected(state);
    expect(state).toMatchObject({ status: "paused", pausedReason: "send_rejected", inflight: null });
    expect(state.items.map((entry) => entry.id)).toEqual(["a", "b"]);
    state = resume(state);
    expect(state.status).toBe("waiting");
    expect(beginDispatch(state, 0).inflight?.item.id).toBe("a");
  });

  it("8. 结果不确定：项回队列区标待核对、paused（send_uncertain）；恢复后不重发它，出队跳过它", () => {
    let state = beginDispatch(baselined(enqueue(enqueue(emptyQueue(), item("a")), item("b"))), 0);
    state = onSendUncertain(state);
    expect(state).toMatchObject({ status: "paused", pausedReason: "send_uncertain", inflight: null });
    expect(state.items.map((entry) => [entry.id, entry.unconfirmed === true])).toEqual([["a", true], ["b", false]]);
    state = resume(state);
    expect(state.status).toBe("waiting");
    expect(beginDispatch(state, 0).inflight?.item.id).toBe("b");
    // 只剩待核对项：恢复后 idle，永不出队
    const onlyUnconfirmed = resume(onSendUncertain(beginDispatch(baselined(enqueue(emptyQueue(), item("a"))), 0)));
    expect(onlyUnconfirmed.status).toBe("idle");
    expect(canDispatch(onlyUnconfirmed, projection({}))).toBe(false);
  });

  it("9. 归属超时：paused（attribution_unconfirmed），项不回队、不在队列里，恢复后不重发", () => {
    let state = onSendAccepted(beginDispatch(baselined(enqueue(enqueue(emptyQueue(), item("a")), item("b"))), 0), "c-a", 1_000);
    state = reconcile(state, projection({ lastSeq: 1 }), 1_000 + ATTRIBUTION_DEADLINE_MS);
    expect(state.inflight?.awaitingTurnId).toBeNull();
    expect(state.status).toBe("dispatch");
    state = reconcile(state, projection({ lastSeq: 1 }), 1_000 + ATTRIBUTION_DEADLINE_MS + 1);
    expect(state).toMatchObject({ status: "paused", pausedReason: "attribution_unconfirmed", inflight: null });
    expect(state.items.map((entry) => entry.id)).toEqual(["b"]);
    expect(resume(state).items.map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("queue 状态机 · 协商补充用例", () => {
  it("seenSeq 基线：首次 reconcile 只设水位，历史 failed/interrupted 不触发暂停、不盖掉 restored", () => {
    const storage = new MemoryStorage();
    saveQueue("s1", baselined(enqueue(emptyQueue(), item("a"))), storage);
    const restored = loadQueue("s1", storage);
    const history = projection({ meta: [{ turnId: "old", status: "failed", endedSeq: 7 }], lastSeq: 9 });
    const first = reconcile(restored, history, 0);
    expect(first).toMatchObject({ status: "paused", pausedReason: "restored", seenSeq: 9 });
    // 恢复后新到的失败终态才暂停
    const resumed = resume(first);
    const failedLater = reconcile(resumed, projection({ meta: [{ turnId: "old", status: "failed", endedSeq: 7 }, { turnId: "new", status: "interrupted", endedSeq: 10 }], lastSeq: 10 }), 0);
    expect(failedLater).toMatchObject({ status: "paused", pausedReason: "turn_interrupted", seenSeq: 10 });
  });

  it("非队列发出的回合失败也暂停（新到的终态）；等待审批不产生终态、不出队", () => {
    const state = baselined(enqueue(emptyQueue(), item("a")), 5);
    const failed = reconcile(state, projection({ meta: [{ turnId: "manual", status: "failed", endedSeq: 6 }], lastSeq: 6 }), 0);
    expect(failed).toMatchObject({ status: "paused", pausedReason: "turn_failed" });
    // 审批中：回合仍 running，无终态 → 仍 waiting 且不可出队
    const approval = reconcile(state, projection({ meta: [{ turnId: "T", status: "running" }], running: ["T"], lastSeq: 6 }), 0);
    expect(approval.status).toBe("waiting");
    expect(canDispatch(approval, projection({ running: ["T"] }))).toBe(false);
  });

  it("accepted 后立刻对账：SSE 先于 HTTP 时投影里已有归属，一次 reconcile 即拿到 awaitingTurnId", () => {
    let state = beginDispatch(baselined(enqueue(emptyQueue(), item("a"))), 0);
    const already = projection({ users: [{ clientTurnId: "c-a", turnId: "T1" }], meta: [{ turnId: "T1", status: "completed", endedSeq: 4 }], lastSeq: 4 });
    state = reconcile(onSendAccepted(state, "c-a", 100), already, 100);
    expect(state.inflight).toBeNull();
    expect(state.status).toBe("idle");
  });

  it("编辑 / 删除 / 取回 / 入队时的状态推导", () => {
    let state = baselined(enqueue(emptyQueue(), item("a")));
    state = updateItem(state, "a", "改过了");
    expect(state.items[0]?.text).toBe("改过了");
    const taken = takeItem(state, "a");
    expect(taken.item?.text).toBe("改过了");
    expect(taken.state.status).toBe("idle");
    expect(removeItem(taken.state, "nope")).toBe(taken.state);
    // paused 时入队不改状态
    const pausedState = enqueue(pause(state, "user_stop"), item("b"));
    expect(pausedState.status).toBe("paused");
  });

  it("classifySendFailure：只有 ApiClientError 4xx 且非 IDEMPOTENCY_INDETERMINATE 才是证实未受理", () => {
    expect(classifySendFailure(new ApiClientError(400, "VALIDATION_ERROR", "bad"))).toBe("rejected");
    expect(classifySendFailure(new ApiClientError(404, "NOT_FOUND", "gone"))).toBe("rejected");
    expect(classifySendFailure(new ApiClientError(409, "SESSION_HAS_NO_PRIMARY_THREAD", "x"))).toBe("rejected");
    expect(classifySendFailure(new ApiClientError(409, "IDEMPOTENCY_INDETERMINATE", "启动 turn 的结果不确定"))).toBe("uncertain");
    expect(classifySendFailure(new ApiClientError(500, "INTERNAL", "x"))).toBe("uncertain");
    expect(classifySendFailure(new ApiClientError(503, "UPSTREAM", "x"))).toBe("uncertain");
    expect(classifySendFailure(new TypeError("Failed to fetch"))).toBe("uncertain");
    expect(classifySendFailure(new Error("timeout"))).toBe("uncertain");
    expect(classifySendFailure("weird")).toBe("uncertain");
  });

  it("只剩待核对项 / 队列为空时 resume 仍可用：解除暂停但不产生可发项，也不会出队", () => {
    const onlyUnconfirmed = resume(onSendUncertain(beginDispatch(baselined(enqueue(emptyQueue(), item("a"))), 0)));
    expect(onlyUnconfirmed).toMatchObject({ status: "idle", pausedReason: null });
    expect(canDispatch(onlyUnconfirmed, projection({}))).toBe(false);
    const emptyPaused = pause(emptyQueue(), "attribution_unconfirmed");
    expect(resume(emptyPaused)).toMatchObject({ status: "idle", pausedReason: null, items: [] });
  });

  it("skill 项连 name 一起持久化：刷新重建后出队组装不依赖 skills 列表", () => {
    const storage = new MemoryStorage();
    const skillOnly: QueueItem = { id: "s", text: "", skill: { name: "review", path: "/repo/.codex/skills/review" }, attachmentIds: [] };
    saveQueue("s1", baselined(enqueue(emptyQueue(), skillOnly)), storage);
    const restored = loadQueue("s1", storage);
    expect(restored.items[0]?.skill).toEqual({ name: "review", path: "/repo/.codex/skills/review" });
    const inflight = beginDispatch(resume(restored), 0).inflight?.item;
    expect(buildMessageContent({ text: inflight?.text ?? "", skill: inflight?.skill, attachmentIds: inflight?.attachmentIds ?? [] })).toEqual([
      { type: "skill", name: "review", path: "/repo/.codex/skills/review" },
    ]);
  });

  it("buildMessageContent：skill → 文本 → 图片（高清），空文本不产出文本项", () => {
    expect(buildMessageContent({ text: "  hi ", skill: { name: "s", path: "/s" }, attachmentIds: ["a1"] })).toEqual([
      { type: "skill", name: "s", path: "/s" },
      { type: "text", text: "hi" },
      { type: "local-image", attachmentId: "a1", detail: "high" },
    ]);
    expect(buildMessageContent({ text: "  ", skill: undefined, attachmentIds: [] })).toEqual([]);
  });
});
