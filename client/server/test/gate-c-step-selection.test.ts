import { describe, expect, it } from "vitest";
import {
  gateCStepPrerequisites,
  gateCSteps,
  resolveGateCStepSelection,
} from "./gate-c/steps/registry.js";

const registryOrder = gateCSteps.map((step) => step.id);

describe("gate-c 步骤子集入口（PR1）", () => {
  it("不设 GATE_C_STEPS 时是全量，且顺序与 registry 数组序逐项一致", () => {
    for (const raw of [undefined, "", "  ", " , "]) {
      const selection = resolveGateCStepSelection(gateCSteps, raw);
      expect(selection.subset).toBe(false);
      expect(selection.steps.map((step) => step.id)).toEqual(registryOrder);
    }
  });

  it("点名步骤会补齐前置闭包，并按 registry 数组序执行", () => {
    const selection = resolveGateCStepSelection(
      gateCSteps,
      "final-interrupt,assistant-approval",
    );
    expect(selection.subset).toBe(true);
    expect(selection.requested).toEqual(["final-interrupt", "assistant-approval"]);
    // v2-user-path 是点名之外由映射算出来的前置；顺序不随点名顺序走。
    expect(selection.steps.map((step) => step.id)).toEqual([
      "v2-user-path",
      "assistant-approval",
      "final-interrupt",
    ]);
  });

  it("前置是传递闭包，不只补一层", () => {
    const selection = resolveGateCStepSelection(gateCSteps, "supervisor-recovery");
    expect(selection.steps.map((step) => step.id)).toEqual([
      "v2-user-path",
      "interrupt-and-reopen",
      "supervisor-recovery",
    ]);
  });

  it("PR7 三条运行态步骤各自只补会话前置，按 registry 数组序执行", () => {
    const selection = resolveGateCStepSelection(
      gateCSteps,
      "stop-pauses-queue,attribution-badge,queue-auto-dispatch",
    );
    expect(selection.steps.map((step) => step.id)).toEqual([
      "v2-user-path",
      "attribution-badge",
      "queue-auto-dispatch",
      "stop-pauses-queue",
    ]);
  });

  it("选中的每一步，其全部前置都在执行序列里且排在它前面", () => {
    for (const id of registryOrder) {
      const order = resolveGateCStepSelection(gateCSteps, id).steps.map(
        (step) => step.id,
      );
      const expand = (target: string, seen: Set<string>): Set<string> => {
        for (const prerequisite of gateCStepPrerequisites[target] ?? []) {
          if (!seen.has(prerequisite)) {
            seen.add(prerequisite);
            expand(prerequisite, seen);
          }
        }
        return seen;
      };
      for (const prerequisite of expand(id, new Set())) {
        expect(order).toContain(prerequisite);
        expect(order.indexOf(prerequisite)).toBeLessThan(order.indexOf(id));
      }
    }
  });

  it("步骤名写错立刻报错，并列出可选值", () => {
    expect(() => resolveGateCStepSelection(gateCSteps, "final-interupt")).toThrow(
      /未知步骤：final-interupt/,
    );
  });

  it("前置表与 registry 必须一一对应（增删步骤时漏登记会失败）", () => {
    expect(Object.keys(gateCStepPrerequisites).sort()).toEqual(
      [...registryOrder].sort(),
    );
  });
});
