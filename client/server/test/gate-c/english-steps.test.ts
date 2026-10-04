import { describe, expect, it } from "vitest";
import {
  gateCEnglishStepPrerequisites,
  gateCEnglishSteps,
  gateCStepPrerequisites,
  gateCSteps,
  gateCStepsFor,
  resolveGateCStepSelection,
} from "./steps/registry.js";

describe("gate-c 按语言选步骤组", () => {
  it("中文仍是原来的全量与前置表", () => {
    const run = gateCStepsFor("zh-CN");
    expect(run.steps).toBe(gateCSteps);
    expect(run.prerequisites).toBe(gateCStepPrerequisites);
    expect(resolveGateCStepSelection(run.steps, undefined, run.prerequisites).steps).toBe(gateCSteps);
  });

  it("英文冒烟：登录复用 v2-user-path，覆盖我的工作、需求、会话一轮、房间、切换语言、设置与英文视觉基线", () => {
    const run = gateCStepsFor("en");
    expect(run.steps).toBe(gateCEnglishSteps);
    expect(run.steps.map((step) => step.id)).toEqual([
      "v2-user-path",
      "en-my-work",
      "en-requirements",
      "en-session-turn",
      "en-rooms",
      "en-locale-switch",
      "en-settings",
      "en-visual",
    ]);
    expect(Object.keys(gateCEnglishStepPrerequisites).sort()).toEqual(run.steps.map((step) => step.id).sort());
    const full = resolveGateCStepSelection(run.steps, "", run.prerequisites);
    expect(full.subset).toBe(false);
  });

  it("英文子集补齐前置；中文步骤名在英文组里是未知步骤", () => {
    const run = gateCStepsFor("en");
    const selection = resolveGateCStepSelection(run.steps, "en-visual,en-rooms", run.prerequisites);
    expect(selection.steps.map((step) => step.id)).toEqual(["v2-user-path", "en-rooms", "en-visual"]);
    expect(() => resolveGateCStepSelection(run.steps, "visual-closeout", run.prerequisites)).toThrow(
      /未知步骤：visual-closeout/,
    );
  });

  it("前置表与步骤组对不上时报错（不悄悄少跑前置）", () => {
    expect(() => resolveGateCStepSelection(gateCEnglishSteps, undefined, gateCStepPrerequisites)).toThrow(
      /前置表/,
    );
  });
});
