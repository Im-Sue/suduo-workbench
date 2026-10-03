// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  codexModels: vi.fn(),
  codexStatusUrl: vi.fn(),
  getSettings: vi.fn(),
  globalSkills: vi.fn(),
  listAllSessions: vi.fn(),
  listMcpServers: vi.fn(),
  listRequirementsMappingsVerified: vi.fn(),
  listRequirementsProjects: vi.fn(),
  logoutRequirements: vi.fn(),
  modelProvider: vi.fn(),
  requirementsSettings: vi.fn(),
  runDoctor: vi.fn(),
  testProxySettings: vi.fn(),
  testRequirementsSettings: vi.fn(),
  updateModelProvider: vi.fn(),
  updateRequirementsSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

const toastMocks = vi.hoisted(() => {
  const toast = vi.fn();
  return { toast, success: vi.fn(), error: vi.fn(), warning: vi.fn() };
});

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

vi.mock("sonner", () => ({
  toast: Object.assign(toastMocks.toast, { success: toastMocks.success, error: toastMocks.error, warning: toastMocks.warning }),
  Toaster: () => null,
}));

import { clearPageFeedback, getPageFeedback } from "../src/feedback/page-store.js";
import {
  buttonByText,
  click,
  localSettings,
  mcpServer,
  MockEventSource,
  modelProviderSettings,
  renderSettings,
  requirementsSettings,
  setInputValue,
  settle,
  type SettingsHarness,
} from "./settings-harness.js";

let harness: SettingsHarness | null = null;

async function open(path: string): Promise<SettingsHarness> {
  harness = await renderSettings(path);
  return harness;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  apiMocks.codexModels.mockResolvedValue({ models: ["gpt-5"], items: [] });
  apiMocks.codexStatusUrl.mockReturnValue("/api/v1/codex/status");
  apiMocks.getSettings.mockResolvedValue(localSettings());
  apiMocks.listAllSessions.mockResolvedValue({ items: [], nextCursor: null });
  apiMocks.globalSkills.mockResolvedValue({ items: [], root: "/tmp/skills" });
  apiMocks.listMcpServers.mockResolvedValue({ items: [], statusAvailable: true });
  apiMocks.listRequirementsMappingsVerified.mockResolvedValue({ items: [] });
  apiMocks.listRequirementsProjects.mockResolvedValue({ items: [], nextCursor: null });
  apiMocks.logoutRequirements.mockResolvedValue(undefined);
  apiMocks.modelProvider.mockResolvedValue(modelProviderSettings());
  apiMocks.requirementsSettings.mockResolvedValue(requirementsSettings());
  apiMocks.runDoctor.mockResolvedValue({ status: "PASS", checks: [] });
  apiMocks.testProxySettings.mockResolvedValue({ reachable: true, targetOrigin: "https://llm.example.com", usingProxy: false, message: "ok" });
  apiMocks.testRequirementsSettings.mockResolvedValue({ baseUrl: "x", reachable: true, message: "可连接" });
  apiMocks.updateModelProvider.mockImplementation(async (body: Record<string, unknown>) => ({
    settings: modelProviderSettings({ contextWindow: body["contextWindow"] ?? null }),
    status: "ok",
    message: "ok",
  }));
  apiMocks.updateRequirementsSettings.mockResolvedValue(requirementsSettings(false));
  apiMocks.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => localSettings(patch));
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(async () => {
  await harness?.unmount();
  harness = null;
  clearPageFeedback();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("设置页 · 保存与确认", () => {
  it("完全访问确认默认聚焦取消，取消绝不写入设置", async () => {
    const { node } = await open("/settings/execution");
    const full = node.querySelector<HTMLButtonElement>('[data-testid="settings-approval-full"]');
    await click(full);
    const dialog = document.querySelector('[data-testid="confirm-dialog"]');
    const cancel = dialog?.querySelector("button");
    expect(cancel?.textContent).toBe("取消");
    expect(document.activeElement).toBe(cancel);
    await click(cancel);
    expect(apiMocks.updateSettings).not.toHaveBeenCalled();
  });

  it("开关类设置立即保存并在原位显示「已保存」，失败回滚并提示", async () => {
    const { node } = await open("/settings/execution");
    const checkpoint = node.querySelector<HTMLButtonElement>('[data-testid="settings-git-checkpoint"]');
    expect(checkpoint?.getAttribute("aria-checked")).toBe("true");
    await click(checkpoint);
    expect(apiMocks.updateSettings).toHaveBeenCalledWith({ gitAutoCheckpointDefault: false });
    expect(node.querySelector('[data-testid="settings-saved-flash"]')?.textContent).toContain("已保存");

    apiMocks.updateSettings.mockRejectedValueOnce({ status: 500, code: "INTERNAL_ERROR", message: "写入失败" });
    await click(checkpoint);
    expect(checkpoint?.getAttribute("aria-checked")).toBe("false");
    expect(toastMocks.error).toHaveBeenCalled();
  });

  it("修改服务地址在确认后才保存，并刷新登录状态", async () => {
    const { node } = await open("/settings/service");
    const input = node.querySelector<HTMLInputElement>("#settings-base-url");
    await act(async () => setInputValue(input, "https://next.example.com"));
    await click(document.querySelector('[data-testid="settings-save"]'));
    expect(apiMocks.updateRequirementsSettings).not.toHaveBeenCalled();

    const dialog = document.querySelector('[data-testid="confirm-dialog"]');
    const buttons = [...(dialog?.querySelectorAll("button") ?? [])];
    const readsBefore = apiMocks.requirementsSettings.mock.calls.length;
    await click(buttons.at(-1));
    expect(apiMocks.updateRequirementsSettings).toHaveBeenCalledWith("https://next.example.com");
    expect(apiMocks.requirementsSettings.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it("服务地址格式不对时不提交，保存条说明有几处要改", async () => {
    const { node } = await open("/settings/service");
    const input = node.querySelector<HTMLInputElement>("#settings-base-url");
    await act(async () => setInputValue(input, "not a url"));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("有效的地址");
    await click(document.querySelector('[data-testid="settings-save"]'));
    expect(apiMocks.updateRequirementsSettings).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="settings-dirty-bar"]')?.textContent).toContain("有 1 处需要修改");
    expect(document.activeElement).toBe(input);
  });

  it("有未保存的更改时切换分组先提醒：继续编辑留在原处，放弃后才离开且不保存", async () => {
    const h = await open("/settings/service");
    const input = h.node.querySelector<HTMLInputElement>("#settings-base-url");
    await act(async () => setInputValue(input, "https://draft.example.com"));
    expect(document.querySelector('[data-testid="settings-dirty-bar"]')?.textContent).toContain("有未保存的更改");

    await click(h.node.querySelector('[data-testid="settings-nav-workspace"]'));
    let dialog = document.querySelector('[data-testid="settings-unsaved-dialog"]');
    expect(dialog?.textContent).toContain("需求服务地址");
    await click(buttonByText(dialog ?? document, "继续编辑"));
    expect(h.pathname()).toBe("/settings/service");
    expect(h.node.querySelector<HTMLInputElement>("#settings-base-url")?.value).toBe("https://draft.example.com");

    await click(h.node.querySelector('[data-testid="settings-nav-workspace"]'));
    dialog = document.querySelector('[data-testid="settings-unsaved-dialog"]');
    await click(buttonByText(dialog ?? document, "放弃更改"));
    expect(h.pathname()).toBe("/settings/workspace");
    expect(h.node.querySelector('[data-testid="settings-group-workspace"]')).not.toBeNull();
    expect(apiMocks.updateRequirementsSettings).not.toHaveBeenCalled();
  });

  it("上下文上限填非数字时标红且不提交（不再提交 NaN），改成整数后正常保存", async () => {
    const { node } = await open("/settings/model");
    const context = node.querySelector<HTMLInputElement>("#model-context");
    await act(async () => setInputValue(context, "20万"));
    expect(context?.getAttribute("aria-invalid")).toBe("true");
    expect(node.textContent).toContain("请输入整数");
    await click(document.querySelector('[data-testid="settings-save"]'));
    expect(apiMocks.updateModelProvider).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(context);

    await act(async () => setInputValue(context, "200000"));
    await click(document.querySelector('[data-testid="settings-save"]'));
    expect(apiMocks.updateModelProvider).toHaveBeenCalledTimes(1);
    const body = apiMocks.updateModelProvider.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body["contextWindow"]).toBe(200000);
    expect(Number.isNaN(body["contextWindow"])).toBe(false);
    expect(toastMocks.success).toHaveBeenCalled();
  });

  it("还没有自定义模型服务（用的是内置默认）：说明现状，地址与 Key 都要填，保存后实连一次地址", async () => {
    apiMocks.modelProvider.mockResolvedValue(
      modelProviderSettings({ configured: false, providerId: "", providerName: "", baseUrl: "", apiKeyMasked: "由 Codex 管理" }),
    );
    apiMocks.updateModelProvider.mockResolvedValue({
      status: "ok",
      message: "ok",
      settings: modelProviderSettings({ baseUrl: "https://gateway.example.com/v1", providerId: "suduo" }),
    });
    const { node } = await open("/settings/model");
    expect(node.querySelector('[data-testid="model-first-time"]')?.textContent).toContain("内置的默认模型服务");
    // 没有地址时测试连接只看清单，不去实连。
    await click(buttonByText(node, "测试连接"));
    await settle();
    expect(node.querySelector('[data-testid="settings-test-result"]')?.textContent).toContain("没有地址可实连");
    expect(apiMocks.testProxySettings).not.toHaveBeenCalled();

    await act(async () => setInputValue(node.querySelector<HTMLInputElement>("#model-base-url"), "https://gateway.example.com/v1"));
    await click(document.querySelector('[data-testid="settings-save"]'));
    expect(apiMocks.updateModelProvider).not.toHaveBeenCalled();
    expect(node.textContent).toContain("改用团队的模型服务需要填写它的 API Key");
    const keyInput = node.querySelector<HTMLInputElement>('[data-testid="model-api-key-input"]');
    expect(keyInput).not.toBeNull();
    expect(node.querySelector('[data-testid="model-api-key-replace-note"]')?.textContent).toContain("替换 Codex 当前的登录");

    await act(async () => setInputValue(keyInput, "sk-test-1234567890"));
    await click(document.querySelector('[data-testid="settings-save"]'));
    await settle();
    expect(apiMocks.updateModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://gateway.example.com/v1", apiKey: "sk-test-1234567890" }),
    );
    expect(apiMocks.testProxySettings).toHaveBeenCalled();
    expect(toastMocks.success).toHaveBeenCalled();
  });

  it("保存成功但地址连不上：照实提醒，不撤销保存", async () => {
    apiMocks.updateModelProvider.mockResolvedValue({ status: "ok", message: "ok", settings: modelProviderSettings({ contextWindow: 200000 }) });
    apiMocks.testProxySettings.mockResolvedValue({
      reachable: false,
      targetOrigin: "https://llm.example.com",
      usingProxy: false,
      message: "无法连接模型网关：ETIMEDOUT",
      failure: { reason: "unreachable", networkCode: "ETIMEDOUT" },
    });
    const { node } = await open("/settings/model");
    await act(async () => setInputValue(node.querySelector<HTMLInputElement>("#model-context"), "200000"));
    await click(document.querySelector('[data-testid="settings-save"]'));
    await settle();
    expect(apiMocks.updateModelProvider).toHaveBeenCalledOnce();
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.warning).toHaveBeenCalled();
    expect(JSON.stringify((toastMocks.warning.mock.calls[0]?.[0] as { props?: unknown })?.props ?? "")).toContain("连接超时");
  });

  it("Key 由配置里的取 Key 命令提供：说明来源，不给「更换」入口", async () => {
    apiMocks.modelProvider.mockResolvedValue(modelProviderSettings({ apiKeyMasked: "由本机命令提供（security）", apiKeySource: "command" }));
    const { node } = await open("/settings/model");
    expect(node.querySelector('[data-testid="model-api-key-masked"]')?.textContent).toBe("由本机命令提供（security）");
    expect(node.querySelector('[data-testid="model-api-key-external"]')?.textContent).toContain("取 Key 命令");
    expect(buttonByText(node, "更换")).toBeUndefined();
  });

  it("模型清单拿得到但服务地址连不上：测试连接判为失败，不误报「连接正常」", async () => {
    apiMocks.testProxySettings.mockResolvedValue({
      reachable: false,
      targetOrigin: "https://llm.example.com",
      usingProxy: false,
      message: "无法连接模型网关：ECONNREFUSED",
      failure: { reason: "unreachable", networkCode: "ECONNREFUSED" },
    });
    const { node } = await open("/settings/model");
    await click(buttonByText(node, "测试连接"));
    await settle();
    const result = node.querySelector('[data-testid="settings-test-result"]');
    expect(result?.getAttribute("data-result")).toBe("failure");
    expect(result?.textContent).toContain("对方拒绝连接");
  });

  it("模型服务有未保存的更改时，测试连接说明原因且不可点", async () => {
    const { node } = await open("/settings/model");
    const test = buttonByText(node, "测试连接");
    expect(test?.disabled).toBe(false);
    await act(async () => setInputValue(node.querySelector<HTMLInputElement>("#model-base-url"), "https://other.example.com/v1"));
    expect(buttonByText(node, "测试连接")?.disabled).toBe(true);
  });

  it("模型服务测试连接：成功与失败两种样式，失败给出原因和建议", async () => {
    const { node } = await open("/settings/model");
    await click(buttonByText(node, "测试连接"));
    await settle();
    let result = node.querySelector('[data-testid="settings-test-result"]');
    expect(result?.getAttribute("data-result")).toBe("success");
    expect(result?.textContent).toContain("可用模型 1 个");

    apiMocks.codexModels.mockRejectedValueOnce({ status: 502, code: "RUNTIME_REQUEST_FAILED", message: "401 Unauthorized" });
    apiMocks.testProxySettings.mockResolvedValueOnce({ reachable: false, targetOrigin: "", usingProxy: false, message: "无法连接模型网关：超时" });
    await click(buttonByText(node, "测试连接"));
    await settle();
    result = node.querySelector('[data-testid="settings-test-result"]');
    expect(result?.getAttribute("data-result")).toBe("failure");
    expect(result?.textContent).toContain("连不上模型服务");
    expect(result?.textContent).toContain("网络代理");
  });
});

describe("设置页 · 读取失败与空态", () => {
  it("读取本机设置 502 在分组内渲染 RegionError，不弹提示", async () => {
    apiMocks.getSettings.mockRejectedValue({ status: 502, code: "DEPENDENCY_UNAVAILABLE" });
    const { node } = await open("/settings/execution");
    const error = node.querySelector('[data-testid="region-error"]');
    expect(error?.getAttribute("data-feedback-kind")).toBe("upstream_unavailable");
    expect(error?.getAttribute("data-feedback-result")).toBe("region");
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("AUTH_INVALID 即使从区域读取也发布页面级反馈", async () => {
    apiMocks.getSettings.mockRejectedValue({ status: 409, code: "AUTH_INVALID" });
    await open("/settings/execution");
    const feedback = getPageFeedback();
    expect(feedback?.failure.kind).toBe("auth_expired");
    expect(feedback?.route.outlet).toBe("page");
  });

  it("代码目录空态使用前置条件 EmptyState", async () => {
    const { node } = await open("/settings/workspace");
    const state = node.querySelector('[data-testid="empty-state"]');
    expect(state?.getAttribute("data-feedback-kind")).toBe("prerequisite");
    expect(state?.textContent).toContain("还没有关联代码目录");
  });

  it("目录失效时显示原因和修复方式，分组导航出现红点", async () => {
    apiMocks.listRequirementsMappingsVerified.mockResolvedValue({
      items: [
        {
          remoteProjectId: "p1",
          localProjectId: "l1",
          rootPath: "/Users/sue/code/pay",
          localProjectName: "支付网关",
          lastValidatedAt: 0,
          verification: { exists: false, readable: false, writable: false, executable: false, available: false, message: "目录不存在" },
        },
      ],
    });
    const { node } = await open("/settings/workspace");
    const row = node.querySelector('[data-testid="settings-mapping-row"]');
    expect(row?.textContent).toContain("目录已不存在");
    expect(row?.textContent).toContain("重新选择");
    expect(row?.textContent).toContain("~/code/pay");
    expect(node.querySelector('[data-testid="settings-nav-workspace"]')?.textContent).toContain("有问题");
  });
});

describe("设置页 · 测试连接、代理、通知、搜索", () => {
  it("代理测试用草稿，不保存；失败时给出原因和建议", async () => {
    apiMocks.testProxySettings.mockResolvedValue({
      reachable: false,
      targetOrigin: "https://llm.example.com",
      usingProxy: true,
      message: "无法连接模型网关：ECONNREFUSED",
      failure: { reason: "unreachable", networkCode: "ECONNREFUSED" },
    });
    const { node } = await open("/settings/proxy");
    await act(async () => setInputValue(node.querySelector<HTMLInputElement>("#settings-proxy-https"), "http://127.0.0.1:7890"));
    await click(buttonByText(node, "测试连接"));
    await settle();
    expect(apiMocks.testProxySettings).toHaveBeenCalledWith(expect.objectContaining({ httpsProxy: "http://127.0.0.1:7890" }));
    expect(apiMocks.updateSettings).not.toHaveBeenCalled();
    const result = node.querySelector('[data-testid="settings-test-result"]');
    expect(result?.getAttribute("data-result")).toBe("failure");
    expect(result?.textContent).toContain("连不上模型服务（经代理）：对方拒绝连接，端口上可能没有服务（ECONNREFUSED）");
    expect(result?.textContent).toContain("检查代理地址和端口");
  });

  it("代理地址不合法时不保存；合法后保存四项", async () => {
    const { node } = await open("/settings/proxy");
    const http = node.querySelector<HTMLInputElement>("#settings-proxy-http");
    await act(async () => setInputValue(http, "ftp://proxy:21"));
    expect(node.textContent).toContain("只支持 http、https、socks5 代理");
    await click(document.querySelector('[data-testid="settings-save"]'));
    expect(apiMocks.updateSettings).not.toHaveBeenCalled();
    await act(async () => setInputValue(http, "http://proxy.corp:8080"));
    await click(document.querySelector('[data-testid="settings-save"]'));
    expect(apiMocks.updateSettings).toHaveBeenCalledWith({ httpProxy: "http://proxy.corp:8080", httpsProxy: "", allProxy: "", noProxy: "" });
  });

  it("有会话在运行时保存代理先说明会中断，由你决定仍然保存还是取消", async () => {
    apiMocks.listAllSessions.mockResolvedValue({
      items: [
        { id: "s1", runStatus: { running: true, pendingApprovals: 0, lastTurnOutcome: null } },
        { id: "s2", runStatus: { running: false, pendingApprovals: 1, lastTurnOutcome: null } },
        { id: "s3", runStatus: { running: false, pendingApprovals: 0, lastTurnOutcome: null } },
      ],
      nextCursor: null,
    });
    const { node } = await open("/settings/proxy");
    await act(async () => setInputValue(node.querySelector<HTMLInputElement>("#settings-proxy-http"), "http://proxy.corp:8080"));
    await click(document.querySelector('[data-testid="settings-save"]'));
    const dialog = document.querySelector('[data-testid="confirm-dialog"]');
    expect(dialog?.textContent).toContain("有 2 个会话正在运行或等你确认");
    expect(apiMocks.updateSettings).not.toHaveBeenCalled();
    await click([...(dialog?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "仍然保存") ?? null);
    expect(apiMocks.updateSettings).toHaveBeenCalledOnce();
  });

  it("系统通知：开启时申请授权，允许后写入本机偏好", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission }));
    const { node } = await open("/settings/notifications");
    const toggle = node.querySelector<HTMLButtonElement>('[data-testid="settings-system-notify"]');
    (window.Notification as unknown as { permission: string }).permission = "granted";
    await click(toggle);
    expect(requestPermission).toHaveBeenCalled();
    expect(localStorage.getItem("suduo.notify.system")).toBe("on");
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("系统通知被浏览器拒绝时说明如何重新允许，不写入开启", async () => {
    const requestPermission = vi.fn().mockImplementation(async () => {
      (window.Notification as unknown as { permission: string }).permission = "denied";
      return "denied";
    });
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission }));
    const { node } = await open("/settings/notifications");
    await click(node.querySelector('[data-testid="settings-system-notify"]'));
    expect(localStorage.getItem("suduo.notify.system")).not.toBe("on");
    const blocked = node.querySelector('[data-testid="settings-notify-blocked"]');
    expect(blocked?.textContent).toContain("改为「允许」");
  });

  it("浏览器早已阻止而偏好是开启：开关照实显示开启并说明原因，可以关掉，关掉后导航不再提示", async () => {
    localStorage.setItem("suduo.notify.system", "on");
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "denied", requestPermission: vi.fn() }));
    const { node } = await open("/settings/notifications");
    const toggle = node.querySelector<HTMLButtonElement>('[data-testid="settings-system-notify"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(node.textContent).toContain("已开启，但浏览器阻止了通知");
    expect(node.querySelector('[data-testid="settings-nav-notifications"]')?.textContent).toContain("需要留意");
    await click(toggle);
    expect(localStorage.getItem("suduo.notify.system")).toBe("off");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(node.querySelector('[data-testid="settings-notify-blocked"]')).toBeNull();
    expect(node.querySelector('[data-testid="settings-nav-notifications"]')?.textContent).not.toContain("需要留意");
  });

  it("搜索设置：输入关键词列出匹配项，回车跳到对应分组的那一行", async () => {
    const h = await open("/settings/appearance");
    const search = h.node.querySelector<HTMLInputElement>('input[aria-label="搜索设置"]');
    await act(async () => setInputValue(search, "代理"));
    const results = [...h.node.querySelectorAll('nav[aria-label="设置分组"] a')].map((link) => link.textContent);
    expect(results.some((text) => text?.includes("HTTP 代理"))).toBe(true);
    await act(async () => search?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(h.pathname()).toBe("/settings/proxy#proxy-http");
  });

  it("MCP 没连上时分组导航出现提示点", async () => {
    apiMocks.listMcpServers.mockResolvedValue({
      items: [mcpServer({ status: { ...mcpServer().status, startupState: "failed" } })],
      statusAvailable: true,
    });
    const { node } = await open("/settings/appearance");
    expect(node.querySelector('[data-testid="settings-nav-mcp"]')?.textContent).toContain("有问题");
  });

  it("Codex 的配置提醒出现在模型服务分组，并让导航亮起提示点", async () => {
    const { node } = await open("/settings/model");
    await act(async () =>
      MockEventSource.instances[0]?.emit("status", {
        entries: [{ nativeType: "configWarning", payload: { summary: "未知的 service_tier", details: null }, receivedAt: 1 }],
      }),
    );
    expect(node.querySelector('[data-testid="model-config-warning"]')?.textContent).toContain("未知的 service_tier");
    expect(node.querySelector('[data-testid="settings-nav-model"]')?.textContent).toContain("需要留意");
  });
});
