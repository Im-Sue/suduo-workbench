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
  modelProvider: vi.fn(),
  requirementsSettings: vi.fn(),
  runDoctor: vi.fn(),
  testProxySettings: vi.fn(),
  updateModelProvider: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  Toaster: () => null,
}));

import { rowLabelId } from "../src/features/settings/components/kit.js";
import { originLabel, parseContextWindow } from "../src/features/settings/sections/ModelSection.js";
import { validateProxyUrl } from "../src/features/settings/sections/ProxySection.js";
import { availabilityText } from "../src/features/settings/sections/WorkspaceSection.js";
import { settingAnchorId } from "../src/features/settings/sections.js";
import { applyLocalePreference } from "../src/i18n/locale.js";
import {
  click,
  localSettings,
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

function rowLabel(node: ParentNode, anchor: string): string | null | undefined {
  return node.querySelector(`#${rowLabelId(anchor)}`)?.textContent;
}

/** 「测试连接」按钮的文字归设置框架，这里按所在的行找。 */
async function runTest(node: ParentNode, anchor: string): Promise<Element | null> {
  await click(node.querySelector(`#${settingAnchorId(anchor)} button`));
  await settle();
  return node.querySelector('[data-testid="settings-test-result"]');
}

const refused = {
  reachable: false,
  targetOrigin: "https://llm.example.com",
  message: "无法连接模型网关：ECONNREFUSED",
  failure: { reason: "unreachable", networkCode: "ECONNREFUSED" },
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  applyLocalePreference("en");
  apiMocks.codexModels.mockResolvedValue({ models: ["gpt-5"], items: [] });
  apiMocks.codexStatusUrl.mockReturnValue("/api/v1/codex/status");
  apiMocks.getSettings.mockResolvedValue(localSettings());
  apiMocks.globalSkills.mockResolvedValue({ items: [], root: "/tmp/skills" });
  apiMocks.listAllSessions.mockResolvedValue({ items: [], nextCursor: null });
  apiMocks.listMcpServers.mockResolvedValue({ items: [], statusAvailable: true });
  apiMocks.listRequirementsMappingsVerified.mockResolvedValue({ items: [] });
  apiMocks.listRequirementsProjects.mockResolvedValue({ items: [], nextCursor: null });
  apiMocks.modelProvider.mockResolvedValue(modelProviderSettings());
  apiMocks.requirementsSettings.mockResolvedValue(requirementsSettings());
  apiMocks.runDoctor.mockResolvedValue({ status: "PASS", checks: [] });
  apiMocks.testProxySettings.mockResolvedValue({ reachable: true, targetOrigin: "https://llm.example.com", usingProxy: false, message: "ok" });
  apiMocks.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => localSettings(patch));
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(async () => {
  await harness?.unmount();
  harness = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  applyLocalePreference("system");
  window.localStorage.clear();
});

describe("英文界面：模型服务", () => {
  it("表单标签、来源标记与校验提示", async () => {
    const managed = { name: { type: "legacyManagedConfigTomlFromMdm" }, version: "1" };
    const user = { name: { type: "user" }, version: "1" };
    apiMocks.modelProvider.mockResolvedValue(
      modelProviderSettings({ origins: { providerId: user, baseUrl: managed, model: user, reasoningEffort: user, contextWindow: user } }),
    );
    const { node } = await open("/settings/model");
    expect(rowLabel(node, "model-url")).toBe("Service URL");
    expect(rowLabel(node, "api-key")).toBe("API key");
    expect(rowLabel(node, "model-name")).toBe("Default model");
    expect(rowLabel(node, "reasoning")).toBe("Default reasoning effort");
    expect(rowLabel(node, "context-window")).toBe("Context limit");
    expect(node.querySelector<HTMLInputElement>("#model-context")?.placeholder).toBe("e.g. 200000");
    const badge = node.querySelector('[data-testid="model-origin-badge"]');
    expect(badge?.textContent).toBe("From admin config");
    expect(badge?.getAttribute("title")).toBe("The value in effect comes from admin config. Changing it here may have no effect.");

    const context = node.querySelector<HTMLInputElement>("#model-context");
    await act(async () => setInputValue(context, "abc"));
    expect(node.querySelector("#model-context-error")?.textContent).toBe("Enter a whole number, e.g. 200000");
  });

  it("测试连接：成功按单复数写模型数，连不上时说明原因并给出去设置代理的入口", async () => {
    const { node } = await open("/settings/model");
    let result = await runTest(node, "model-test");
    expect(result?.textContent).toMatch(/^Connected · 1 model available · /);

    apiMocks.testProxySettings.mockResolvedValue({ ...refused, usingProxy: false });
    result = await runTest(node, "model-test");
    expect(result?.getAttribute("data-result")).toBe("failure");
    expect(result?.textContent).toContain(
      "Can't reach the model service: the connection was refused; nothing may be listening on that port (ECONNREFUSED)",
    );
    expect(result?.textContent).toContain("Set up network proxy");
  });

  it("React 之外的函数按当前语言出文字", () => {
    expect(parseContextWindow("3999")).toEqual({ ok: false, message: "Enter a whole number from 4000 to 100000000" });
    expect(originLabel({ name: "project", version: "1" })).toBe("project config");
  });
});

describe("英文界面：网络代理", () => {
  it("字段标签、校验提示与试连失败说明", async () => {
    apiMocks.testProxySettings.mockResolvedValue({ ...refused, usingProxy: true });
    const { node } = await open("/settings/proxy");
    expect(rowLabel(node, "proxy-http")).toBe("HTTP proxy");
    expect(rowLabel(node, "proxy-https")).toBe("HTTPS proxy");
    expect(rowLabel(node, "proxy-all")).toBe("Proxy for other connections");
    expect(rowLabel(node, "no-proxy")).toBe("No-proxy addresses");

    const http = node.querySelector<HTMLInputElement>("#settings-proxy-http");
    await act(async () => setInputValue(http, "ftp://proxy:21"));
    expect(node.querySelector("#settings-proxy-http-error")?.textContent).toBe("Only http, https, and socks5 proxies are supported");
    let result = await runTest(node, "proxy-test");
    expect(result?.textContent).toBe("Fix the addresses marked in red above before testing.");

    await act(async () => setInputValue(http, "http://127.0.0.1:7890"));
    result = await runTest(node, "proxy-test");
    expect(result?.getAttribute("data-result")).toBe("failure");
    expect(result?.textContent).toContain("Can't reach the model service (via proxy): the connection was refused");
    expect(result?.textContent).toContain("You can add internal addresses to “No-proxy addresses”.");
    expect(validateProxyUrl("http://user:pass@proxy:8080")).toBe("Proxies with a username and password aren't supported yet");
  });

  it("保存前提示正在运行的会话（单复数）", async () => {
    apiMocks.listAllSessions.mockResolvedValue({
      items: [{ runStatus: { running: true, pendingApprovals: 0 } }],
      nextCursor: null,
    });
    const { node } = await open("/settings/proxy");
    await act(async () => setInputValue(node.querySelector<HTMLInputElement>("#settings-proxy-http"), "http://proxy.corp:8080"));
    await click(document.querySelector('[data-testid="settings-save"]'));
    const dialog = document.querySelector('[data-testid="confirm-dialog"]');
    expect(dialog?.textContent).toContain("1 session is running or waiting for you");
    expect([...(dialog?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toContain("Save anyway");
    expect(apiMocks.updateSettings).not.toHaveBeenCalled();
  });
});

describe("英文界面：代码目录", () => {
  it("空状态", async () => {
    const { node } = await open("/settings/workspace");
    expect(node.querySelector('[data-testid="empty-state"]')?.textContent).toContain("No local folders linked yet");
    expect(rowLabel(node, "mappings")).toBe("Linked projects");
  });

  it("目录失效的一行：原因、操作与读屏文字", async () => {
    apiMocks.listRequirementsMappingsVerified.mockResolvedValue({
      items: [
        {
          remoteProjectId: "p1",
          localProjectId: "l1",
          rootPath: "/Users/alex/code/checkout",
          localProjectName: "Checkout",
          lastValidatedAt: 0,
          verification: { exists: false, readable: false, writable: false, executable: false, available: false, message: "目录不存在" },
        },
      ],
    });
    const { node } = await open("/settings/workspace");
    const row = node.querySelector('[data-testid="settings-mapping-row"]');
    expect(row?.getAttribute("aria-label")).toBe("Checkout: Folder no longer exists");
    expect(row?.querySelector('[data-testid="mapping-availability"]')?.textContent).toBe("Folder no longer exists");
    expect(row?.textContent).toContain("Choose again");
    expect(row?.querySelector('button[aria-label="More actions for “Checkout”"]')).not.toBeNull();
    expect(
      availabilityText({ exists: true, readable: false, writable: true, executable: true, available: false, message: "" }).text,
    ).toBe("SuDuo doesn't have permission to read and write this folder");
  });
});
