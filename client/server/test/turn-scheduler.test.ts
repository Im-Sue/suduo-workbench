import { describe, expect, it } from "vitest";
import { SchedulerCancelledError, TurnScheduler } from "../src/application/scheduler/turn-scheduler.js";

/** 本机回合调度（多 Agent 协作 S8，需求 4.11）。 */

function setup(limits: { global?: number; perAgent?: Record<string, number> } = {}) {
  let clock = 1_000;
  const scheduler = new TurnScheduler({
    limits: () => ({ global: limits.global ?? 4, perAgent: (agentId) => limits.perAgent?.[agentId] ?? 2 }),
    now: () => (clock += 1),
  });
  const request = (sessionId: string, agentId: string, source: "user" | "delegate" = "user") =>
    scheduler.request({ sessionId, agentId, source, label: sessionId });
  const settled = async (promise: Promise<void>) => {
    let state = "pending";
    promise.then(
      () => (state = "admitted"),
      (error: unknown) => (state = error instanceof SchedulerCancelledError ? "cancelled" : "failed"),
    );
    await Promise.resolve();
    await Promise.resolve();
    return state;
  };
  return { scheduler, request, settled };
}

describe("回合调度", () => {
  it("每家 2 个、合计 4 个：超出的排队（不拒绝），某一家满了不挡别家；回合结束放行下一个", async () => {
    const { scheduler, request, settled } = setup();
    const a1 = request("s1", "claude-code");
    const a2 = request("s2", "claude-code");
    const a3 = request("s3", "claude-code");
    const b1 = request("s4", "codex");
    expect([a1.immediate, a2.immediate, a3.immediate, b1.immediate]).toEqual([true, true, false, true]);
    expect(await settled(a3.admitted)).toBe("pending");
    expect(scheduler.position(a3.id)).toBe(1);
    a1.started("t1");
    scheduler.turnEnded("s1", "t1");
    expect(await settled(a3.admitted)).toBe("admitted");
    expect(scheduler.snapshot().running.map((item) => item.sessionId).sort()).toEqual(["s2", "s3", "s4"]);
  });

  it("合计满了：哪家都排队；先跑这个移到队首；取消排队的让等的人收到取消", async () => {
    const { scheduler, request, settled } = setup({ global: 2 });
    const first = request("s1", "codex");
    request("s2", "claude-code");
    const third = request("s3", "gemini");
    const fourth = request("s4", "opencode");
    expect([third.immediate, fourth.immediate]).toEqual([false, false]);
    expect(scheduler.promote(fourth.id)).toBe(true);
    expect(scheduler.snapshot().queued.map((item) => [item.sessionId, item.position])).toEqual([
      ["s4", 1],
      ["s3", 2],
    ]);
    expect(scheduler.cancel(third.id)).toBe(true);
    expect(await settled(third.admitted)).toBe("cancelled");
    first.release();
    expect(await settled(fourth.admitted)).toBe("admitted");
    expect(scheduler.cancel(fourth.id)).toBe(false);
  });

  it("开不起来就还名额；重复还无害；对账把账本里已经不在跑的回合的名额还掉", async () => {
    const { scheduler, request, settled } = setup({ perAgent: { codex: 1 } });
    const first = request("s1", "codex");
    const second = request("s2", "codex");
    first.release();
    first.release();
    expect(await settled(second.admitted)).toBe("admitted");
    second.started("t2");
    const third = request("s3", "codex");
    scheduler.reconcile(() => ["t2"]);
    expect(await settled(third.admitted)).toBe("pending");
    scheduler.reconcile(() => []);
    expect(await settled(third.admitted)).toBe("admitted");
    expect(scheduler.sessionRunning("s3")).toBe(true);
    expect(scheduler.sessionRunning("s2")).toBe(false);
    // 拿到名额后一直没开起来（开回合卡住）：过了老化时间、账本里也没在跑，收回。
    const fourth = request("s4", "codex");
    scheduler.reconcile(() => [], 0, 0);
    expect(await settled(fourth.admitted)).toBe("admitted");
    expect(scheduler.sessionRunning("s3")).toBe(false);
  });

  it("同一会话一次只放行一个；运行时自己接着开的回合补登记、照样占名额；终态先于登记到达时立即还", async () => {
    const { scheduler, request, settled } = setup({ perAgent: { claude: 2 } });
    const first = request("s1", "claude");
    first.started("t1");
    // 同一会话再排一项：家里还有名额，也要等这一轮结束。
    const second = request("s1", "claude");
    expect(second.immediate).toBe(false);
    const other = request("s2", "claude");
    expect(await settled(other.admitted)).toBe("admitted");
    other.release();
    scheduler.turnEnded("s1", "t1");
    expect(await settled(second.admitted)).toBe("admitted");
    second.started("t2");
    scheduler.turnEnded("s1", "t2");
    // Claude 会话内排队的下一轮自己开始了：补登记，占名额。
    scheduler.turnStarted({ sessionId: "s1", agentId: "claude", turnId: "t3", label: "s1" });
    scheduler.turnStarted({ sessionId: "s3", agentId: "claude", turnId: "t9", label: "s3" });
    expect(scheduler.snapshot().running.map((item) => item.turnId)).toEqual(["t3", "t9"]);
    const waiting = request("s4", "claude");
    expect(waiting.immediate).toBe(false);
    scheduler.turnEnded("s1", "t3");
    expect(await settled(waiting.admitted)).toBe("admitted");
    // 刚拿到名额、还在开的那一项：开始事件先到就直接记上回合 ID，不另登记。
    scheduler.turnStarted({ sessionId: "s4", agentId: "claude", turnId: "t4", label: "s4" });
    expect(scheduler.snapshot().running.filter((item) => item.sessionId === "s4")).toHaveLength(1);
    // 终态先于 started() 到达。
    scheduler.turnEnded("s3", "t9");
    const late = request("s5", "codex");
    scheduler.turnEnded("s5", "t5");
    late.started("t5");
    expect(scheduler.sessionRunning("s5")).toBe(false);
  });

  it("上限调大后立即放行排队项", async () => {
    let perAgent = 1;
    const scheduler = new TurnScheduler({ limits: () => ({ global: 4, perAgent: () => perAgent }) });
    scheduler.request({ sessionId: "s1", agentId: "codex", source: "user", label: "a" });
    const queued = scheduler.request({ sessionId: "s2", agentId: "codex", source: "user", label: "b" });
    perAgent = 2;
    scheduler.refresh();
    await expect(queued.admitted).resolves.toBeUndefined();
  });

  it("按会话取消排队中的（停止级联）；上限改了下次调度就生效", async () => {
    let global = 1;
    const scheduler = new TurnScheduler({ limits: () => ({ global, perAgent: () => 2 }) });
    const running = scheduler.request({ sessionId: "s1", agentId: "codex", source: "user", label: "" });
    const queued = scheduler.request({ sessionId: "child", agentId: "codex", source: "delegate", label: "" });
    expect(scheduler.sessionQueued("child")).toBe(true);
    expect(scheduler.cancelSession("child")).toBe(1);
    await expect(queued.admitted).rejects.toBeInstanceOf(SchedulerCancelledError);
    global = 3;
    expect(scheduler.request({ sessionId: "s2", agentId: "codex", source: "user", label: "" }).immediate).toBe(true);
    void running;
  });

  it("还在开的也算会话有待办；还在开时被叫停，开起来就回调；取消带原因；发起方等委派时让出名额", async () => {
    const { scheduler, request, settled } = setup({ perAgent: { codex: 1 } });
    const opening = request("s1", "codex");
    expect(scheduler.sessionPending("s1")).toBe(true);
    const stopped: string[] = [];
    expect(scheduler.whenStarted(opening.id, (turnId) => stopped.push(turnId))).toBe(true);
    opening.started("t1");
    expect(stopped).toEqual(["t1"]);
    expect(scheduler.sessionPending("s1")).toBe(false);

    const queued = request("s2", "codex");
    scheduler.cancelSession("s2", "archived");
    await expect(queued.admitted).rejects.toMatchObject({ reason: "archived" });

    // s1 在等委派结果：让出名额，同一家的子会话能开；收回后暂时超出上限、别的要等。
    const child = request("child", "codex");
    expect(await settled(child.admitted)).toBe("pending");
    const giveBack = scheduler.lend("s1");
    expect(await settled(child.admitted)).toBe("admitted");
    giveBack();
    const later = request("s3", "codex");
    expect(later.immediate).toBe(false);
  });
});
