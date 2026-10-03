import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import { projectEvents } from "../src/event-projection/reducer.js";

let seqCounter = 0;

function mkEvent(
  type: string,
  payload: JsonValue,
  turnId: string | null = null,
): EventEnvelope<string, JsonValue> {
  seqCounter += 1;
  return {
    schemaVersion: 1,
    seq: seqCounter,
    eventId: `evt-${String(seqCounter)}`,
    sessionId: "s1",
    source: "test",
    type,
    payload,
    threadRef: null,
    turnRef: turnId === null ? null : { threadId: "t1", turnId },
    ts: 1_000 + seqCounter,
  };
}

describe("projectEvents · per-turn 状态机", () => {
  it("完整 turn 生命周期聚合为 completed 组", () => {
    seqCounter = 0;
    const events = [
      mkEvent("turn.started", {}, "turn-1"),
      mkEvent(
        "item.started",
        { item: { id: "i1", type: "commandExecution", command: "ls" } },
        "turn-1",
      ),
      mkEvent("command.output-delta", { itemId: "i1", delta: "file.txt\n" }, "turn-1"),
      mkEvent(
        "item.completed",
        { item: { id: "i1", type: "commandExecution", command: "ls" } },
        "turn-1",
      ),
      mkEvent("turn.completed", {}, "turn-1"),
    ];
    const projection = projectEvents(events);
    expect(projection.turns).toHaveLength(1);
    const turn = projection.turns[0];
    expect(turn.status).toBe("completed");
    expect(turn.turnId).toBe("turn-1");
    expect(turn.commandCount).toBe(1);
    expect(turn.truncatedHead).toBe(false);
    expect(turn.steps[0].output).toBe("file.txt\n");
    expect(turn.endedTs).not.toBeNull();
    expect(projection.runningTurnIds).toHaveLength(0);
  });

  it("turn.interrupted 收口未完成 step，避免永久 spinner", () => {
    seqCounter = 0;
    const events = [
      mkEvent("turn.started", {}, "turn-1"),
      mkEvent(
        "item.started",
        { item: { id: "i1", type: "commandExecution", command: "sleep 100" } },
        "turn-1",
      ),
      mkEvent("turn.interrupted", {}, "turn-1"),
    ];
    const projection = projectEvents(events);
    expect(projection.turns[0].status).toBe("interrupted");
    expect(projection.turns[0].steps[0].status).toBe("aborted");
    expect(projection.runningTurnIds).toHaveLength(0);
    // 顶层 interrupted 已删（无人消费）；终态看 turnMeta。
    expect(projection.turnMeta.get("turn-1")?.status).toBe("interrupted");
  });

  it("turnId 为 null 的 item 进入独立未归属组", () => {
    seqCounter = 0;
    const events = [
      mkEvent("turn.started", {}, "turn-1"),
      mkEvent("item.started", { item: { id: "i1", type: "tool", name: "搜索" } }, null),
      mkEvent("turn.completed", {}, "turn-1"),
    ];
    const projection = projectEvents(events);
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].turnId).toBeNull();
    // 未归属组不被 turn-1 的 terminal 收口。
    expect(projection.turns[0].steps[0].status).toBe("running");
  });

  it("缓存从 turn 中段回放时标记 truncatedHead / partial", () => {
    seqCounter = 0;
    const mid = [
      mkEvent(
        "item.completed",
        { item: { id: "i9", type: "commandExecution", command: "ls" } },
        "turn-9",
      ),
    ];
    const projection = projectEvents(mid);
    expect(projection.turns[0].truncatedHead).toBe(true);
    expect(projection.turns[0].status).toBe("partial");
    // 后续 terminal 到达则升级为终态，但保留截断标记。
    const withTerminal = [...mid, mkEvent("turn.completed", {}, "turn-9")];
    const upgraded = projectEvents(withTerminal);
    expect(upgraded.turns[0].status).toBe("completed");
    expect(upgraded.turns[0].truncatedHead).toBe(true);
  });

  it("用户消息与流式助手消息正确聚合", () => {
    seqCounter = 0;
    const events = [
      mkEvent(
        "message.submitted",
        { content: [{ type: "text", text: "你好" }] },
        "turn-1",
      ),
      mkEvent("message.delta", { text: "收" }, "turn-1"),
      mkEvent("message.delta", { text: "到" }, "turn-1"),
    ];
    const projection = projectEvents(events);
    expect(projection.messages).toHaveLength(2);
    expect(projection.messages[0]).toMatchObject({ role: "user", text: "你好" });
    expect(projection.messages[1]).toMatchObject({ role: "assistant", text: "收到" });
  });

  it("turn.completed 携带 status=failed 时判定为失败并产出错误卡（429 实录形状）", () => {
    seqCounter = 0;
    const events = [
      mkEvent("turn.started", {}, "turn-1"),
      mkEvent(
        "turn.completed",
        {
          threadId: "t1",
          turn: {
            id: "turn-1",
            items: [],
            status: "failed",
            error: {
              message: "exceeded retry limit, last status: 429 Too Many Requests",
              codexErrorInfo: {
                responseTooManyFailedAttempts: { httpStatusCode: 429 },
              },
            },
          },
        },
        "turn-1",
      ),
    ];
    const projection = projectEvents(events);
    // 无任何 step 的失败 turn 也必须产卡，否则用户只看到死寂。
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].status).toBe("failed");
    expect(projection.turns[0].errorMessage).toContain("429");
    expect(projection.turns[0].errorMessage).toContain("限流");
    expect(projection.runningTurnIds).toHaveLength(0);
  });

  it("turn.completed 无 status 字段时保持 completed（历史事件兼容）", () => {
    seqCounter = 0;
    const events = [
      mkEvent("turn.started", {}, "turn-1"),
      mkEvent("turn.completed", {}, "turn-1"),
    ];
    const projection = projectEvents(events);
    // 无 step 的成功 turn 依旧不产卡。
    expect(projection.turns).toHaveLength(0);
    expect(projection.runningTurnIds).toHaveLength(0);
  });

  it("runtime.error 兼容 Codex 的 error.message 嵌套结构", () => {
    seqCounter = 0;
    const events = [
      mkEvent("runtime.error", {
        error: { message: "exceeded retry limit, last status: 429 Too Many Requests" },
        willRetry: false,
      }),
    ];
    const projection = projectEvents(events);
    // 不再是无人读取的全局字符串：没有回合归属的运行时错误成为会话提示。
    expect(projection.timeline).toMatchObject([{ kind: "notice", notice: { level: "error" } }]);
    const [entry] = projection.timeline;
    expect(entry?.kind === "notice" ? entry.notice.text : "").toContain("限流");
  });

  it("仅有 item.completed 的 agentMessage 也能重建助手完整回复", () => {
    seqCounter = 0;
    const projection = projectEvents([
      mkEvent(
        "item.completed",
        { item: { id: "agent-1", type: "agentMessage", text: "完整回复" } },
        "turn-1",
      ),
    ]);
    expect(projection.messages).toMatchObject([
      { role: "assistant", text: "完整回复", turnId: "turn-1" },
    ]);
  });

  it("thread.attached 的线程重建提示使用事件自带文案并弱化展示", () => {
    seqCounter = 0;
    const projection = projectEvents([
      mkEvent("thread.attached", {
        reason: "resume-failed-rebuilt",
        message: "此前对话内容 AI 已不记得，但记录完整保留",
      }),
    ]);
    expect(projection.notices).toMatchObject([
      {
        text: "此前对话内容 AI 已不记得，但记录完整保留",
        level: "info",
      },
    ]);
  });

  it("runtime.warning 的 thread-rebuilt 提示使用事件自带文案并弱化展示", () => {
    seqCounter = 0;
    const projection = projectEvents([
      mkEvent("runtime.warning", {
        code: "thread-rebuilt",
        message: "此前对话内容 AI 已不记得，但记录完整保留",
      }),
    ]);
    expect(projection.notices).toMatchObject([
      {
        text: "此前对话内容 AI 已不记得，但记录完整保留",
        level: "info",
      },
    ]);
  });
});

/** 与 server 整链测试共享的 fixture（client/server/test/attribution-chain.test.ts 生成并校验）。 */
const CHAIN_FIXTURE = new URL("../../server/test/fixtures/attribution-chain.events.json", import.meta.url);

function userSubmitted(clientTurnId: string, text = "hi"): EventEnvelope<string, JsonValue> {
  return mkEvent("message.submitted", { content: [{ type: "text", text }], clientTurnId });
}

function userItem(
  type: "item.started" | "item.completed",
  clientId: string,
  turnId: string,
  id = `item-${clientId}`,
): EventEnvelope<string, JsonValue> {
  return mkEvent(type, { item: { id, type: "userMessage", clientId, content: [] } }, turnId);
}

describe("projectEvents · 归属三态（PR2）", () => {
  it("规则 ①：找不到 clientId 对应的 userMessage item → 已提交，turnId 为 null", () => {
    seqCounter = 0;
    const projection = projectEvents([
      userSubmitted("c1"),
      mkEvent("turn.started", {}, "T"),
    ]);
    expect(projection.messages[0]).toMatchObject({
      role: "user", clientTurnId: "c1", turnId: null, attribution: "submitted", interruptedNote: false,
    });
  });

  it("规则 ②：所属回合未见 turn.started（缓存截断）→ 已提交，但真实 turnId 保留为关联事实", () => {
    seqCounter = 0;
    const projection = projectEvents([
      userSubmitted("c1"),
      userItem("item.started", "c1", "T"),
      userItem("item.completed", "c1", "T"),
    ]);
    expect(projection.messages[0]).toMatchObject({ turnId: "T", attribution: "submitted" });
    expect(projection.turnMeta.get("T")).toMatchObject({ sawStart: false, status: "partial" });
  });

  it("规则 ③ / ④：回合内首条 userMessage item → 已作为新一轮；其后的 → 已并入当前工作", () => {
    seqCounter = 0;
    const projection = projectEvents([
      userSubmitted("c1"),
      mkEvent("turn.started", {}, "T"),
      userItem("item.started", "c1", "T"),
      userItem("item.completed", "c1", "T"),
      userSubmitted("c2"),
      userItem("item.started", "c2", "T"),
      userItem("item.completed", "c2", "T"),
    ]);
    expect(projection.messages.map((message) => [message.clientTurnId, message.turnId, message.attribution])).toEqual([
      ["c1", "T", "new-turn"],
      ["c2", "T", "merged"],
    ]);
  });

  it("Codex 反例 submitted(A) < submitted(B) < started(X)：A=新一轮 / B=并入（不看本机入账先后）", () => {
    seqCounter = 0;
    const projection = projectEvents([
      userSubmitted("A"),
      userSubmitted("B"),
      mkEvent("turn.started", {}, "X"),
      userItem("item.started", "A", "X"),
      userItem("item.started", "B", "X"),
    ]);
    expect(projection.messages.map((message) => message.attribution)).toEqual(["new-turn", "merged"]);
  });

  it("回合以 interrupted 终止：插入型消息带限定语，新一轮那条不带", () => {
    seqCounter = 0;
    const projection = projectEvents([
      userSubmitted("c1"),
      mkEvent("turn.started", {}, "T"),
      userItem("item.started", "c1", "T"),
      userSubmitted("c2"),
      userItem("item.started", "c2", "T"),
      mkEvent("turn.interrupted", {}, "T"),
    ]);
    expect(projection.messages.map((message) => [message.attribution, message.interruptedNote])).toEqual([
      ["new-turn", false],
      ["merged", true],
    ]);
  });

  it("同一 clientId 被报到两个回合 = 歧义：退回已提交且不挂任何 turnId", () => {
    seqCounter = 0;
    const projection = projectEvents([
      userSubmitted("c1"),
      mkEvent("turn.started", {}, "T1"),
      userItem("item.started", "c1", "T1"),
      mkEvent("turn.started", {}, "T2"),
      userItem("item.started", "c1", "T2", "item-dup"),
    ]);
    expect(projection.messages[0]).toMatchObject({ turnId: null, attribution: "submitted" });
  });

  it("纯文本无 step 的成功回合：turnMeta 有 completed 记录且 endedSeq = 终态事件 seq；turns 仍不含它", () => {
    seqCounter = 0;
    const events = [
      mkEvent("turn.started", {}, "T"),
      mkEvent("item.completed", { item: { id: "m1", type: "agentMessage", text: "只回一段文字" } }, "T"),
      mkEvent("turn.completed", { turn: { id: "T", status: "completed" } }, "T"),
    ];
    const projection = projectEvents(events);
    expect(projection.turns).toHaveLength(0);
    expect(projection.turnMeta.get("T")).toEqual({
      turnId: "T", status: "completed", sawStart: true, startedTs: events[0].ts, endedTs: events[2].ts, endedSeq: events[2].seq, currentStep: null,
    });
    // 运行中与未归属组：前者 endedSeq 为 null，后者不进 turnMeta。
    const running = projectEvents([mkEvent("turn.started", {}, "R"), mkEvent("item.started", { item: { id: "x", type: "tool" } }, null)]);
    expect(running.turnMeta.get("R")).toMatchObject({ status: "running", endedSeq: null });
    expect(running.turnMeta.size).toBe(1);
  });

  it("每个终态回合的 endedSeq 等于各自终态事件的 seq（含 failed / interrupted）", () => {
    seqCounter = 0;
    const events = [
      mkEvent("turn.started", {}, "T1"),
      mkEvent("turn.interrupted", {}, "T1"),
      mkEvent("turn.started", {}, "T2"),
      mkEvent("turn.completed", { turn: { id: "T2", status: "failed", error: { message: "boom" } } }, "T2"),
    ];
    const projection = projectEvents(events);
    expect(projection.turnMeta.get("T1")).toMatchObject({ status: "interrupted", endedSeq: events[1].seq });
    expect(projection.turnMeta.get("T2")).toMatchObject({ status: "failed", endedSeq: events[3].seq });
  });

  it("只有 message.delta 的回合也进 turnMeta（message.delta 分支不建 TurnState 的旧路径已补）", () => {
    seqCounter = 0;
    const projection = projectEvents([mkEvent("message.delta", { text: "…" }, "T")]);
    expect(projection.turnMeta.get("T")).toMatchObject({ status: "partial", sawStart: false });
    expect(projection.turns).toHaveLength(0);
  });

  it("旧格式事件回放（没有任何 userMessage item）：投影正确，全部为已提交", () => {
    seqCounter = 0;
    const projection = projectEvents([
      mkEvent("message.submitted", { content: [{ type: "text", text: "旧消息" }] }),
      mkEvent("turn.started", {}, "T"),
      mkEvent("message.delta", { text: "回" }, "T"),
      mkEvent("turn.completed", {}, "T"),
    ]);
    expect(projection.messages).toMatchObject([
      { role: "user", text: "旧消息", clientTurnId: null, turnId: null, attribution: "submitted" },
      { role: "assistant", text: "回", turnId: "T" },
    ]);
  });

  it("整链 fixture（与 server 共享）：A 新一轮、B 并入同一真实回合，纯文本终态可供动作卡解析", () => {
    const raw = JSON.parse(readFileSync(CHAIN_FIXTURE, "utf8")) as Array<{
      type: string; source: string; payload: JsonValue; threadRef: JsonValue; turnRef: { threadId: string; turnId: string } | null;
    }>;
    const substitute = (value: unknown): unknown => {
      if (typeof value === "string") {
        return value === "<clientTurnId:A>" ? "client-a" : value === "<clientTurnId:B>" ? "client-b" : value;
      }
      if (Array.isArray(value)) return value.map(substitute);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)]));
      }
      return value;
    };
    const events = raw.map((event, index): EventEnvelope<string, JsonValue> => ({
      schemaVersion: 1,
      seq: index + 1,
      eventId: `evt-${String(index + 1)}`,
      sessionId: "s1",
      source: event.source as EventEnvelope<string, JsonValue>["source"],
      type: event.type,
      payload: substitute(event.payload) as JsonValue,
      threadRef: event.threadRef as EventEnvelope<string, JsonValue>["threadRef"],
      turnRef: event.turnRef,
      ts: 1_000 + index,
    }));
    const projection = projectEvents(events);
    expect(projection.messages.filter((message) => message.role === "user")).toMatchObject([
      { clientTurnId: "client-a", turnId: "turn-real-1", attribution: "new-turn" },
      { clientTurnId: "client-b", turnId: "turn-real-1", attribution: "merged" },
    ]);
    expect(projection.messages.at(-1)).toMatchObject({ role: "assistant", text: "done", turnId: "turn-real-1" });
    expect(projection.turns).toHaveLength(0);
    expect(projection.turnMeta.get("turn-real-1")).toMatchObject({ status: "completed", endedSeq: events.length });
    // 历史回放（回填端点会滤掉 message.delta，本 fixture 本就不含）与实时是同一份判定。
    expect(projectEvents([...events].reverse()).messages.map((message) => message.attribution))
      .toEqual(projection.messages.map((message) => message.attribution));
  });
});

describe("projectEvents · 当前步骤（PR3）", () => {
  it("currentStep 取 running step 里 seq 最大者，同毫秒 ts 并列也不靠插入序；完成后回落到更早的 running step，全完成为 null", () => {
    seqCounter = 0;
    const sameTs = (type: string, payload: JsonValue, turnId: string) => {
      const event = mkEvent(type, payload, turnId);
      return { ...event, ts: 1_000 };
    };
    const events = [
      sameTs("turn.started", {}, "T"),
      sameTs("item.started", { item: { id: "a", type: "commandExecution", command: "pnpm install" } }, "T"),
      sameTs("item.started", { item: { id: "b", type: "commandExecution", command: "pnpm test" } }, "T"),
    ];
    const running = projectEvents(events);
    expect(running.turnMeta.get("T")?.currentStep).toEqual({ kind: "command", title: "执行命令", detail: "pnpm test" });
    expect(running.turns[0]?.currentStep).toEqual({ kind: "command", title: "执行命令", detail: "pnpm test" });
    // b 完成 → 当前步骤回落到仍在跑的 a
    const afterB = projectEvents([...events, sameTs("item.completed", { item: { id: "b", type: "commandExecution", command: "pnpm test" } }, "T")]);
    expect(afterB.turnMeta.get("T")?.currentStep).toEqual({ kind: "command", title: "执行命令", detail: "pnpm install" });
    // 全完成 → null；终态收口未完成 step 后也是 null
    const done = projectEvents([...events, sameTs("turn.completed", {}, "T")]);
    expect(done.turnMeta.get("T")?.currentStep).toBeNull();
  });
});
