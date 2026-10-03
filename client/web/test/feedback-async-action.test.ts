import { describe, expect, it, vi } from "vitest";
import {
  INITIAL_ASYNC_ACTION_STATE,
  createLatestWins,
  createSingleFlight,
  reduceAsyncAction,
} from "../src/feedback/async-action.js";

describe("异步动作契约", () => {
  it("latest-wins：旧请求乱序完成不会覆盖当前请求", () => {
    const pending = reduceAsyncAction(INITIAL_ASYNC_ACTION_STATE, { type: "start", requestId: 1 });
    const latest = reduceAsyncAction(pending, { type: "start", requestId: 2 });
    expect(reduceAsyncAction(latest, { type: "success", requestId: 1 })).toBe(latest);
    expect(reduceAsyncAction(latest, { type: "success", requestId: 2 })).toMatchObject({ status: "success" });

    const policy = createLatestWins();
    const first = policy.start();
    const second = policy.start();
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it("dispose 后旧结果不回写，写入按资源 single-flight", async () => {
    const pending = reduceAsyncAction(INITIAL_ASYNC_ACTION_STATE, { type: "start", requestId: 1 });
    const disposed = reduceAsyncAction(pending, { type: "dispose" });
    expect(reduceAsyncAction(disposed, { type: "failed", requestId: 1, error: new Error("late") })).toBe(disposed);

    const flight = createSingleFlight<number>();
    const task = vi.fn().mockResolvedValue(7);
    const first = flight.run("requirement:r1", task);
    const second = flight.run("requirement:r1", task);
    expect(first).toBe(second);
    await expect(second).resolves.toBe(7);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
