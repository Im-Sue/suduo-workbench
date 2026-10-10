import { describe, expect, it } from "vitest";
import { APPROVAL_STALL_MS, SILENT_STALL_MS, StallWatch } from "../src/application/collab/stall-watch.js";

/** 委派、评审的卡住提醒（多 Agent S12）：只提醒，不动它。 */
describe("卡住提醒", () => {
  it("等确认超过 10 分钟提醒（不管回合在不在跑）；回合在跑、15 分钟没有事件提醒；来了事件就不算没动静；排队中不算", () => {
    let clock = 1_000_000;
    let approvalAt: number | null = null;
    const watch = new StallWatch({ now: () => clock, oldestApprovalAt: () => approvalAt });
    expect(watch.stalled("d1", "s1", true)).toBeNull();
    clock += SILENT_STALL_MS;
    expect(watch.stalled("d1", "s1", true)).toEqual({ reason: "silent", since: 1_000_000 });
    expect(watch.stalled("d1", "s1", false)).toBeNull();
    watch.touch("d1");
    expect(watch.stalled("d1", "s1", true)).toBeNull();
    approvalAt = clock;
    clock += APPROVAL_STALL_MS - 1;
    expect(watch.stalled("d1", "s1", true)).toBeNull();
    clock += 1;
    expect(watch.stalled("d1", "s1", false)).toEqual({ reason: "approval", since: approvalAt });
    expect(watch.stalled("d1", null, true)).toBeNull();
  });

  it("卡住与否（与原因）变了才需要刷新卡片", () => {
    const watch = new StallWatch({ now: () => 0, oldestApprovalAt: () => null });
    expect(watch.changed("d1", null)).toBe(false);
    expect(watch.changed("d1", { reason: "silent", since: 0 })).toBe(true);
    expect(watch.changed("d1", { reason: "silent", since: 0 })).toBe(false);
    expect(watch.changed("d1", { reason: "approval", since: 0 })).toBe(true);
    expect(watch.changed("d1", null)).toBe(true);
    watch.forget("d1");
    expect(watch.changed("d1", null)).toBe(false);
  });
});
