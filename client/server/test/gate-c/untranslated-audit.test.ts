import { describe, expect, it } from "vitest";
import { GATE_C_FIXTURE_HUMAN_TEXTS } from "./requirements-service-fixture.js";
import { containsCjk, findUntranslated, untranslatedSummary } from "./untranslated-audit.js";

const allowed = [...GATE_C_FIXTURE_HUMAN_TEXTS, "Gate C 会话", "简体中文"];

describe("英文界面漏翻检查", () => {
  it("中文检测与 eslint 同一范围：CJK 文字与全角标点", () => {
    expect(containsCjk("Search requirements")).toBe(false);
    expect(containsCjk("“quoted” · …")).toBe(false);
    expect(containsCjk("暂无")).toBe(true);
    expect(containsCjk("Message：")).toBe(true);
    expect(containsCjk("「x」")).toBe(true);
  });

  it("纯英文、夹具人写内容嵌在英文里，都不算漏翻", () => {
    const findings = findUntranslated(
      [
        { where: "button", text: "Start session" },
        { where: "button aria-label", text: "Switch project: Gate C 远程项目" },
        { where: "a", text: "REQ-1 看板草稿一 · Draft · Gate C 用户" },
        { where: "textarea placeholder", text: "Message “Gate C 远程项目”, @ a teammate or a shared agent" },
        { where: "radio", text: "简体中文" },
      ],
      allowed,
    );
    expect(findings).toEqual([]);
  });

  it("界面截断的人写长文字（至少两个字的一截）也放过", () => {
    expect(findUntranslated([{ where: "a", text: "Gate C 用户: 这是一条普通评论，应继续…" }], allowed)).toEqual([]);
  });

  it("漏翻的界面文字、混进英文句子的全角标点都会报出，并给出剩下的片段", () => {
    const findings = findUntranslated(
      [
        { where: "h2", text: "暂无" },
        { where: "label", text: "Model：gpt" },
        { where: "button", text: "Retry 看板草稿一 重试" },
      ],
      allowed,
    );
    expect(findings.map((item) => [item.where, item.residue])).toEqual([
      ["h2", ["暂无"]],
      ["label", ["："]],
      ["button", ["重试"]],
    ]);
  });

  it("整轮结论：没有漏翻为 null，有则逐页列出元素与剩下的片段", () => {
    expect(untranslatedSummary([])).toBeNull();
    const summary = untranslatedSummary([
      { page: "rooms", findings: findUntranslated([{ where: "h2 @room-header", text: "暂无" }], allowed) },
    ]);
    expect(summary).toContain("rooms");
    expect(summary).toContain("h2 @room-header");
    expect(summary).toContain("暂无");
  });

  it("同一元素同一文字只报一次", () => {
    const sample = { where: "h2", text: "暂无" };
    expect(findUntranslated([sample, sample], allowed)).toHaveLength(1);
  });
});
