import { describe, expect, it } from "vitest";
import { shortenPath, humanizeProxyMessage } from "../src/features/settings/format.js";
import {
  doctorHealth,
  loginHealth,
  mcpHealth,
  modelHealth,
  networkHealth,
  serviceHealth,
  workspaceHealth,
} from "../src/features/settings/health.js";
import { searchSettings, sectionFromLegacyHash, SETTINGS_SEARCH_INDEX, SETTINGS_SECTIONS } from "../src/features/settings/sections.js";
import { effortOptions, parseContextWindow, originLabel } from "../src/features/settings/sections/ModelSection.js";
import { networkReason, validateProxyUrl } from "../src/features/settings/sections/ProxySection.js";
import { validateServiceUrl } from "../src/features/settings/sections/ServiceSection.js";
import { availabilityText } from "../src/features/settings/sections/WorkspaceSection.js";

const signedIn = {
  configured: true,
  baseUrl: "http://192.168.1.10:4100",
  session: { user: { id: "u1", loginName: "sue", displayName: "Sue" }, expiresAt: "2026-10-28T00:00:00.000Z" },
  mappingCount: 1,
};

describe("设置分组与搜索", () => {
  it("旧版 /settings#组 映射到新分组", () => {
    expect(sectionFromLegacyHash("#account")).toBe("account");
    expect(sectionFromLegacyHash("#capability")).toBe("skills");
    expect(sectionFromLegacyHash("#security")).toBe("execution");
    expect(sectionFromLegacyHash("#diagnostics")).toBe("diagnostics");
    expect(sectionFromLegacyHash("proxy")).toBe("proxy");
    expect(sectionFromLegacyHash("")).toBeNull();
    expect(sectionFromLegacyHash("#nope")).toBeNull();
  });

  it("需求 §4.7 的分组都在，另有通知一组", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.title)).toEqual([
      "外观",
      "通知",
      "账号",
      "需求服务",
      "代码目录",
      "模型服务",
      "执行与安全",
      "Skills",
      "MCP 服务",
      "网络代理",
      "诊断",
      "关于",
    ]);
  });

  it("搜索按标题、分组名和关键词匹配，多个词需同时命中", () => {
    expect(searchSettings("暗色").map((item) => item.anchor)).toEqual(["theme"]);
    expect(searchSettings("代理 socks").map((item) => item.anchor)).toEqual(["proxy-all"]);
    expect(searchSettings("API").some((item) => item.anchor === "api-key")).toBe(true);
    expect(searchSettings("   ")).toEqual([]);
    // 索引里的锚点不重复，搜索结果跳转才不会落错行。
    const anchors = SETTINGS_SEARCH_INDEX.map((item) => item.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});

describe("表单校验", () => {
  it("上下文上限：留空为不声明；非整数、越界都拒绝（不会得到 NaN）", () => {
    expect(parseContextWindow("")).toEqual({ ok: true, value: null });
    expect(parseContextWindow(" 200,000 ")).toEqual({ ok: true, value: 200000 });
    expect(parseContextWindow("abc").ok).toBe(false);
    expect(parseContextWindow("12.5").ok).toBe(false);
    expect(parseContextWindow("20万").ok).toBe(false);
    expect(parseContextWindow("3999").ok).toBe(false);
    expect(parseContextWindow("100000001").ok).toBe(false);
  });

  it("代理地址与服务端同一套规则", () => {
    expect(validateProxyUrl("")).toBeNull();
    expect(validateProxyUrl("http://127.0.0.1:7890")).toBeNull();
    expect(validateProxyUrl("socks5h://proxy:1080")).toBeNull();
    expect(validateProxyUrl("ftp://proxy:21")).toContain("只支持");
    expect(validateProxyUrl("http://user:pass@proxy:8080")).toContain("账号密码");
    expect(validateProxyUrl("http://proxy:8080/path")).toContain("不带路径");
    expect(validateProxyUrl("proxy:8080")).not.toBeNull();
  });

  it("需求服务地址必须是 http(s)", () => {
    expect(validateServiceUrl("http://192.168.1.10:4100")).toBeNull();
    expect(validateServiceUrl("")).toContain("请填写");
    expect(validateServiceUrl("192.168.1.10")).not.toBeNull();
    expect(validateServiceUrl("ftp://x")).toContain("http");
  });
});

describe("界面用语", () => {
  it("配置层来源翻译成人话，来自自己配置时不显示", () => {
    expect(originLabel({ name: { type: "user" }, version: "1" })).toBeNull();
    expect(originLabel({ name: "system", version: "1" })).toBe("系统配置");
    expect(originLabel({ name: { type: "legacyManagedConfigTomlFromMdm" }, version: "1" })).toBe("管理员配置");
    expect(originLabel(null)).toBeNull();
  });

  it("服务端的字段名、网关等词换成界面用语", () => {
    expect(humanizeProxyMessage("httpsProxy 不是合法代理 URL")).toBe("HTTPS 代理 不是合法代理 URL");
    expect(networkReason("无法连接模型网关：连接被拒绝")).toBe("连接被拒绝");
    expect(networkReason("无法连接模型网关：ECONNREFUSED")).toBe("对方拒绝连接，端口上可能没有服务（ECONNREFUSED）");
    expect(networkReason("当前代理环境变量无效，无法进行连通性检查")).toBe("当前启动环境里的代理变量无效，无法进行连通性检查");
  });

  it("目录可用性与路径缩写", () => {
    const ok = { exists: true, readable: true, writable: true, executable: true, available: true, message: "" };
    expect(availabilityText(ok)).toEqual({ ok: true, text: "可用" });
    expect(availabilityText({ ...ok, exists: false, available: false })).toEqual({ ok: false, text: "目录已不存在" });
    expect(availabilityText({ ...ok, writable: false, available: false }).text).toContain("没有权限");
    expect(shortenPath("/Users/sue/code/order")).toBe("~/code/order");
    expect(shortenPath("/srv/code")).toBe("/srv/code");
  });
});

describe("诊断结论", () => {
  it("需求服务：未配置 / 检查中 / 连不上 / 正常，各给修复入口", () => {
    expect(serviceHealth({ ...signedIn, configured: false, baseUrl: null }, { pending: false })).toMatchObject({
      status: "fail",
      fix: { section: "service" },
    });
    expect(serviceHealth(signedIn, { pending: true }).status).toBe("checking");
    expect(serviceHealth(signedIn, { pending: false, error: new Error("down") })).toMatchObject({
      status: "fail",
      detail: "连不上 192.168.1.10:4100",
    });
    expect(serviceHealth(signedIn, { pending: false, data: {} }).status).toBe("ok");
  });

  it("登录：未登录给去登录", () => {
    expect(loginHealth({ ...signedIn, session: null })).toMatchObject({ status: "fail", fix: { login: true } });
    expect(loginHealth(signedIn).detail).toContain("Sue");
  });

  it("查不到时如实写「没能完成检查」，不当成正常", () => {
    const failed = { pending: false, error: { status: 503, code: "DEPENDENCY_UNAVAILABLE", message: "down" } };
    expect(doctorHealth(failed, "codex").status).toBe("unknown");
    expect(networkHealth(failed).status).toBe("unknown");
    expect(mcpHealth(failed).status).toBe("unknown");
    expect(networkHealth(failed).detail).toContain("没能完成检查");
  });

  it("模型服务：未配置 → 去配置；取不到模型清单 → 有问题；有配置提醒 → 需要留意", () => {
    const provider = {
      providerId: "g",
      providerName: "g",
      baseUrl: "https://llm",
      apiKeyMasked: "由 Codex 管理",
      model: null,
      reasoningEffort: null,
      contextWindow: null,
      origins: { providerId: null, baseUrl: null, model: null, reasoningEffort: null, contextWindow: null },
    };
    expect(modelHealth({ pending: false, data: { ...provider, apiKeyMasked: null } }, { pending: true }, null)).toMatchObject({
      status: "warn",
      fix: { section: "model" },
    });
    expect(modelHealth({ pending: false, data: provider }, { pending: false, error: new Error("401") }, null).status).toBe("fail");
    expect(
      modelHealth({ pending: false, data: provider }, { pending: false, data: { models: ["a"] } }, { summary: "未知字段" }),
    ).toMatchObject({ status: "warn", detail: "可用，但 Codex 对当前配置有提醒：未知字段" });
    expect(modelHealth({ pending: false, data: provider }, { pending: false, data: { models: ["a", "b"] } }, null).detail).toBe(
      "可用 · 2 个模型",
    );
  });

  it("网络、MCP、代码目录", () => {
    expect(networkHealth({ pending: false, data: { reachable: false, usingProxy: true, message: "" } })).toMatchObject({
      status: "fail",
      fix: { section: "proxy" },
    });
    const server = (name: string, startupState: string, enabled = true) =>
      ({ name, enabled, status: { startupState } }) as never;
    expect(mcpHealth({ pending: false, data: { items: [], statusAvailable: true } }).status).toBe("ok");
    expect(
      mcpHealth({ pending: false, data: { items: [server("a", "ready"), server("b", "failed")], statusAvailable: true } }),
    ).toMatchObject({ status: "warn", detail: "「b」没有连上", fix: { section: "mcp" } });
    expect(mcpHealth({ pending: false, data: { items: [server("b", "failed", false)], statusAvailable: true } }).status).toBe("ok");
    const mapping = (available: boolean) =>
      ({
        remoteProjectId: "p1",
        localProjectId: "l1",
        rootPath: "/x",
        localProjectName: "支付",
        lastValidatedAt: 0,
        verification: { exists: available, readable: available, writable: available, executable: available, available, message: "" },
      }) as never;
    expect(workspaceHealth({ pending: false, data: [] }, () => "").status).toBe("warn");
    expect(workspaceHealth({ pending: false, data: [mapping(false)] }, () => "支付网关")).toMatchObject({
      status: "fail",
      detail: "「支付网关」的目录已不存在",
    });
    expect(workspaceHealth({ pending: false, data: [mapping(true)] }, () => "").status).toBe("ok");
  });
});

describe("默认推理强度的选项", () => {
  const models = {
    models: ["gpt-6-sol", "gpt-5.5"],
    items: [
      { id: "gpt-6-sol", model: "gpt-6-sol", displayName: "GPT-6-Sol", isDefault: false, supportedReasoningEfforts: ["ultra", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
      { id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", isDefault: true, supportedReasoningEfforts: ["minimal", "low", "medium", "high"], defaultReasoningEffort: "medium" },
    ],
  };

  it("按选中模型在清单里声明的档位，从弱到强排好", () => {
    // ultra（极致+，会自动分派子代理）暂不提供。
    expect(effortOptions(models, "gpt-6-sol", "")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("没选模型时按 Codex 的默认模型", () => {
    expect(effortOptions(models, "", "")).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("已保存的值不在其中也保留；模型不在清单里时给常见几档", () => {
    expect(effortOptions(models, "gpt-6-sol", "minimal")).toEqual(["low", "medium", "high", "xhigh", "max", "minimal"]);
    expect(effortOptions(models, "gpt-6-sol", "ultra")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(effortOptions(undefined, "my-model", "")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });
});
