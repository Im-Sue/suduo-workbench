import { describe, expect, it } from "vitest";
import { GATE_C_FIXTURE_HUMAN_TEXTS } from "./requirements-service-fixture.js";
import {
  aiTextsFromEvents,
  containsCjk,
  findUntranslated,
  uncoveredRegions,
  untranslatedSummary,
} from "./untranslated-audit.js";

const allowed = [...GATE_C_FIXTURE_HUMAN_TEXTS, "Gate C 会话", "简体中文"];

describe("英文界面漏翻检查", () => {
  it("中文检测与 eslint 同一范围：CJK 文字与全角标点", () => {
    expect(containsCjk("Search requirements")).toBe(false);
    expect(containsCjk("“quoted” · …")).toBe(false);
    expect(containsCjk("暂无")).toBe(true);
    expect(containsCjk("Message：")).toBe(true);
    expect(containsCjk("「x」")).toBe(true);
  });

  it("纯英文、夹具人写内容整段嵌在英文里，都不算漏翻", () => {
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

  it("单独出现的常用词都算漏翻——哪怕它们是某段人写内容的一截", () => {
    const words = [
      "删除",
      "发布",
      "评论",
      "需求",
      "会话",
      "讨论",
      "项目",
      "材料",
      "暂缓",
      "草稿",
      "梳理",
      "消息",
      "继续",
      "显示",
      "用户",
      "普通评论",
      "远程项目",
      "删除材料",
      "发布材料",
      "取消",
      "保存",
      "重试",
      "设置",
    ];
    for (const word of words) {
      expect(findUntranslated([{ where: "button", text: word }], allowed), word).toHaveLength(1);
    }
  });

  it("脚本截断的人写长文字：只放过「允许文字的前缀（至少 4 个字）+ 省略号」", () => {
    expect(findUntranslated([{ where: "a", text: "Gate C 用户: 这是一条普通评论，应继续…" }], allowed)).toEqual([]);
    expect(findUntranslated([{ where: "a", text: "Latest: 欢迎来到项目讨论..." }], allowed)).toEqual([]);
    // 没有省略号就不是截断：同样一截要报。
    expect(findUntranslated([{ where: "a", text: "这是一条普通评论，应继续" }], allowed)).toHaveLength(1);
    // 前缀太短（和常用词分不开）不放过。
    expect(findUntranslated([{ where: "button", text: "发布…" }], allowed)).toHaveLength(1);
    // 不是允许文字开头的一截也不放过。
    expect(findUntranslated([{ where: "a", text: "普通评论，应继续…" }], allowed)).toHaveLength(1);
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

  it("同一块同一文字只报一次", () => {
    const sample = { where: "h2", text: "暂无" };
    expect(findUntranslated([sample, sample], allowed)).toHaveLength(1);
  });

  it("必须查到的区域：没有一段文字落在里面就报出来", () => {
    const samples = [
      { where: "b @health-item", text: "Model service", testIds: ["health-item", "settings-health-list", "settings-page"] },
      { where: "span @settings-page", text: "Diagnostics", testIds: ["settings-page"] },
    ];
    expect(uncoveredRegions(samples, ["health-item", "settings-page"])).toEqual([]);
    expect(uncoveredRegions(samples, ["health-item", "settings-doctor-checks"])).toEqual(["settings-doctor-checks"]);
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
});

describe("会话事件里 Codex 写的文字", () => {
  it("思考摘要按 itemId 拼起来，取开头的 **标题**（步骤标题「思考：标题」用它）；审批理由原样", () => {
    const texts = aiTextsFromEvents([
      { type: "reasoning.summary-part-added", payload: { itemId: "r1", summaryIndex: 0 } },
      { type: "reasoning.summary-delta", payload: { itemId: "r1", summaryIndex: 0, delta: "**准备运行" } },
      { type: "reasoning.summary-delta", payload: { itemId: "r1", summaryIndex: 0, delta: "命令**\n\n先看看 skill。" } },
      { type: "approval.requested", payload: { request: { reason: "需要写入 GATE_C_ACCEPT.md" } } },
      {
        type: "item.completed",
        payload: { item: { id: "r2", type: "reasoning", summary: ["**Checking files**", "Done."] } },
      },
      { type: "item.completed", payload: { item: { id: "m1", type: "agentMessage", text: "不收：在内容区域里" } } },
    ]);
    expect(texts).toEqual(expect.arrayContaining(["准备运行命令", "需要写入 GATE_C_ACCEPT.md", "Checking files"]));
    expect(texts).not.toContain("不收：在内容区域里");
    // 「思考：标题」放过；标题里的一截单独出现仍要报。
    expect(findUntranslated([{ where: "button @tool-card", text: "Thinking: 准备运行命令" }], texts)).toEqual([]);
    expect(findUntranslated([{ where: "button", text: "准备" }], texts)).toHaveLength(1);
  });
});
