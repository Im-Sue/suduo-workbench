import { describe, expect, it } from "vitest";
import type { TimelineStep } from "../src/event-projection/timeline.js";
import { collapseEmptyThinking } from "../src/features/sessions/stream/describe.js";

function step(id: string, overrides: Partial<TimelineStep> = {}): TimelineStep {
  return {
    id,
    kind: "thinking",
    title: "思考",
    detail: "",
    output: "",
    progress: null,
    status: "completed",
    exitCode: null,
    durationMs: 1_000,
    startedTs: Number(id.replace(/\D/gu, "")) * 10,
    endedTs: Number(id.replace(/\D/gu, "")) * 10 + 5,
    seq: Number(id.replace(/\D/gu, "")),
    ...overrides,
  };
}

describe("collapseEmptyThinking", () => {
  it("连续的空思考合成一行「思考 ×N」，时长相加，其他步骤原样保留", () => {
    const steps = [
      step("s1", { kind: "tool", title: "发评论", status: "waiting" }),
      step("s2"),
      step("s3"),
      step("s4", { durationMs: null }),
      step("s5", { kind: "command", title: "运行 ls" }),
      step("s6"),
    ];
    const collapsed = collapseEmptyThinking(steps);
    expect(collapsed.map((item) => item.title)).toEqual(["发评论", "思考 ×3", "运行 ls", "思考"]);
    expect(collapsed[1]).toMatchObject({ id: "s2", durationMs: 2_000, endedTs: 45 });
  });

  it("有摘要或还在进行的思考不合并", () => {
    const steps = [step("s1"), step("s2", { output: "梳理依赖" }), step("s3", { status: "running" }), step("s4")];
    expect(collapseEmptyThinking(steps).map((item) => item.id)).toEqual(["s1", "s2", "s3", "s4"]);
  });
});
