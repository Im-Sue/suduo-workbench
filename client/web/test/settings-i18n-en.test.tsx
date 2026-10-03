// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  codexModels: vi.fn(),
  codexStatusUrl: vi.fn(),
  getSettings: vi.fn(),
  listMcpServers: vi.fn(),
  listRequirementsMappingsVerified: vi.fn(),
  listRequirementsProjects: vi.fn(),
  modelProvider: vi.fn(),
  openCodexConfigFile: vi.fn(),
  requirementsSettings: vi.fn(),
  runDoctor: vi.fn(),
  testProxySettings: vi.fn(),
  testRequirementsSettings: vi.fn(),
  updateRequirementsSettings: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

import { formatMs } from "../src/features/settings/components/TestConnection.js";
import { formatDay, humanizeModelMessage, humanizeProxyMessage } from "../src/features/settings/format.js";
import { mcpHealth, networkHealth, workspaceHealth } from "../src/features/settings/health.js";
import { searchSettings, settingsSections } from "../src/features/settings/sections.js";
import { validateServiceUrl } from "../src/features/settings/sections/ServiceSection.js";
import { applyLocalePreference } from "../src/i18n/locale.js";
import {
  buttonByText,
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

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

let harness: SettingsHarness | null = null;

async function open(path: string): Promise<SettingsHarness> {
  harness = await renderSettings(path);
  return harness;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  applyLocalePreference("en");
  apiMocks.codexModels.mockResolvedValue({ models: ["gpt-5"], items: [] });
  apiMocks.codexStatusUrl.mockReturnValue("/api/v1/codex/status");
  apiMocks.getSettings.mockResolvedValue(localSettings());
  apiMocks.listMcpServers.mockResolvedValue({ items: [], statusAvailable: true });
  apiMocks.listRequirementsMappingsVerified.mockResolvedValue({ items: [] });
  apiMocks.listRequirementsProjects.mockResolvedValue({ items: [], nextCursor: null });
  apiMocks.modelProvider.mockResolvedValue(modelProviderSettings());
  apiMocks.requirementsSettings.mockResolvedValue(requirementsSettings());
  apiMocks.runDoctor.mockResolvedValue({
    status: "PASS",
    checks: [
      { name: "Codex CLI", status: "pass", message: "codex-cli 0.159.2" },
      { name: "workspace.writable", status: "pass", message: "ok" },
    ],
  });
  apiMocks.testProxySettings.mockResolvedValue({ reachable: true, targetOrigin: "https://llm.example.com", usingProxy: true, message: "ok" });
  apiMocks.testRequirementsSettings.mockResolvedValue({ baseUrl: "x", reachable: true, message: "ok", version: null });
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(async () => {
  await harness?.unmount();
  harness = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete (navigator as { clipboard?: unknown }).clipboard;
  document.body.innerHTML = "";
  applyLocalePreference("system");
  localStorage.clear();
});

describe("设置页：英文界面", () => {
  it("分组导航、分段标题与搜索框用英文", async () => {
    const { node } = await open("/settings/about");
    const nav = node.querySelector('nav[aria-label="Settings sections"]');
    expect(nav).not.toBeNull();
    expect(nav?.querySelector("h1")?.textContent).toBe("Settings");
    expect(nav?.querySelector<HTMLInputElement>('input[type="search"]')?.placeholder).toBe("Search settings");
    expect([...(nav?.querySelectorAll("a[data-settings-nav]") ?? [])].map((link) => link.textContent)).toEqual([
      "Appearance",
      "Notifications",
      "Account",
      "Requirements service",
      "Local folders",
      "Model service",
      "Execution and safety",
      "Skills",
      "MCP servers",
      "Network proxy",
      "Diagnostics",
      "About",
    ]);
    expect(nav?.textContent).toContain("General");
    expect(nav?.textContent).toContain("Other");
    expect(nav?.textContent).not.toMatch(CJK);
  });

  it("设置搜索：中文、英文关键词都能找到同一行，结果用英文显示", async () => {
    for (const query of ["许可", "license"]) {
      expect(searchSettings(query).map((item) => [item.anchor, item.title]), query).toEqual([["license", "License"]]);
    }
    for (const query of ["暗色", "dark"]) {
      expect(searchSettings(query).map((item) => item.anchor), query).toEqual(["theme"]);
    }
    // 分组名也参与匹配：中文分组名能搜到英文界面下的行。
    expect(searchSettings("诊断").map((item) => item.anchor)).toEqual(["health", "all-checks"]);
    expect(searchSettings("代理 socks").map((item) => item.title)).toEqual(["Proxy for other connections"]);

    const h = await open("/settings/appearance");
    const search = h.node.querySelector<HTMLInputElement>('input[aria-label="Search settings"]');
    await act(async () => setInputValue(search, "许可"));
    const nav = h.node.querySelector('nav[aria-label="Settings sections"]');
    expect(nav?.querySelector('[role="status"]')?.textContent).toBe("1 result");
    expect([...(nav?.querySelectorAll("a") ?? [])].map((link) => link.textContent)).toEqual(["LicenseAbout"]);
    await act(async () => search?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(h.pathname()).toBe("/settings/about#license");

    await act(async () => setInputValue(search, "zzz"));
    expect(nav?.querySelector('[role="status"]')?.textContent).toBe("No matching settings");
  });

  it("关于：版本、许可与高级入口用英文", async () => {
    const { node } = await open("/settings/about");
    await vi.waitFor(() => expect(node.querySelector('[data-testid="settings-cloud-version"]')?.textContent).toBe(
      "Unknown (older servers don't report their version)",
    ));
    const group = node.querySelector('[data-testid="settings-group-about"]');
    expect(group?.querySelector("h2")?.textContent).toBe("About");
    expect(group?.textContent).toContain("Codex CLI");
    expect(node.querySelector('[data-testid="settings-app-version"]')?.textContent).toBe("Development build");
    const links = [...(node.querySelector('[data-testid="settings-license"]')?.querySelectorAll("a") ?? [])].map((link) => link.textContent);
    expect(links).toContain("How to register (opens in a new tab)");
    expect(group?.textContent).toContain("Companies need to register within 30 days");
    expect(buttonByText(node, "Open in editor")).toBeDefined();
    expect(group?.textContent).not.toMatch(CJK);
  });

  it("诊断：健康检查、自检明细与复制的诊断信息用英文", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { node } = await open("/settings/diagnostics");
    await vi.waitFor(() =>
      expect(node.querySelector('[data-testid="settings-health-list"]')?.getAttribute("aria-busy")).toBe("false"),
    );
    const group = node.querySelector('[data-testid="settings-group-diagnostics"]');
    expect(group?.querySelector("h2")?.textContent).toBe("Diagnostics");
    expect(buttonByText(node, "Check again")).toBeDefined();

    const detail = (key: string) => node.querySelector(`[data-testid="health-item"][data-key="${key}"]`)?.textContent ?? "";
    expect(detail("service")).toBe("Requirements service: OK · Connected · requirements.example.com");
    expect(detail("login")).toContain("Signed in as Sue · Expires ");
    expect(detail("codex")).toBe("Codex CLI: OK · Installed, version 0.159.2");
    expect(detail("network")).toBe("Network and proxy: OK · Model service reachable (via proxy)");
    expect(detail("mcp")).toBe("MCP servers: OK · None configured (optional)");
    expect(detail("workspace")).toBe("Local folders: Needs attention · No local folders linked yetLink folder");
    expect(group?.textContent).toContain("All 2 checks passed");
    expect(group?.textContent).toContain("View all 2 checks");
    expect(group?.textContent).not.toMatch(CJK);

    await click(buttonByText(node, "Copy diagnostics"));
    const report = JSON.parse(writeText.mock.calls[0]?.[0] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(report).join(" ")).not.toMatch(CJK);
    expect(report["SuDuo version"]).toBe("Development build");
    expect((report["Summary"] as Record<string, string>[])[0]).toEqual({
      Item: "Requirements service",
      Status: "OK",
      Details: "Connected · requirements.example.com",
    });
  });

  it("未保存的更改：保存条与离开前提醒用英文", async () => {
    const h = await open("/settings/service");
    const input = h.node.querySelector<HTMLInputElement>("#settings-base-url");
    expect(input?.placeholder).toBe("e.g. http://192.168.1.10:4100");
    await act(async () => setInputValue(input, "https://draft.example.com"));
    const bar = document.querySelector('[data-testid="settings-dirty-bar"]');
    expect(bar?.getAttribute("aria-label")).toBe("Unsaved changes");
    expect(bar?.textContent).toContain("Unsaved changes");
    expect(buttonByText(bar ?? document, "Discard")).toBeDefined();

    await click(h.node.querySelector('[data-testid="settings-nav-about"]'));
    const dialog = document.querySelector('[data-testid="settings-unsaved-dialog"]');
    expect(dialog?.querySelector("h2")?.textContent).toBe("Unsaved changes");
    expect(dialog?.textContent).toContain(
      "Your changes to “Requirements service URL” haven't been saved. They'll be lost if you leave.",
    );
    expect([...(dialog?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual([
      "Keep editing",
      "Discard changes",
    ]);
    await click(buttonByText(dialog ?? document, "Keep editing"));
    expect(h.pathname()).toBe("/settings/service");
  });

  it("React 外的文字按调用时的语言取", () => {
    expect(settingsSections().map((section) => section.title)).toContain("Network proxy");
    expect(humanizeProxyMessage("httpsProxy must be a valid proxy URL")).toBe("HTTPS proxy must be a valid proxy URL");
    expect(humanizeModelMessage("baseUrl is required")).toBe("Service URL is required");
    expect(formatMs(42)).toBe("42 ms");
    expect(formatMs(1_234)).toBe("1.2 s");
    expect(formatDay("not a date")).toBe("Unknown");
    expect(formatDay(new Date(2026, 9, 28), new Date(2026, 9, 3))).toBe("Oct 28");
    expect(formatDay(new Date(2027, 0, 3), new Date(2026, 9, 3))).toBe("Jan 3, 2027");
    expect(validateServiceUrl("")).toBe("Enter the service URL");
    expect(networkHealth({ pending: false, data: { reachable: false, usingProxy: false, message: "" } }).detail).toBe(
      "Can't reach the model service (direct)",
    );
    const server = (name: string) => ({ name, enabled: true, status: { startupState: "failed" } }) as never;
    expect(mcpHealth({ pending: false, data: { items: [server("a"), server("b")], statusAvailable: true } }).detail).toBe(
      "“a” and “b” aren't connected",
    );
    const broken = { verification: { exists: false, available: false } } as never;
    expect(workspaceHealth({ pending: false, data: [broken, broken] }, () => "Checkout").detail).toBe(
      "The folder for “Checkout” no longer exists; 1 other project also has problems",
    );
  });
});

describe("许可链接按界面语言", () => {
  it("商用登记说明链到对应语言的版本", async () => {
    const { licenseLinks } = await import("../src/features/settings/license.js");
    expect(licenseLinks("en").commercial).toMatch(/\/COMMERCIAL\.md$/);
    expect(licenseLinks("zh-CN").commercial).toMatch(/\/COMMERCIAL\.zh-CN\.md$/);
    expect(licenseLinks("en").license).toBe(licenseLinks("zh-CN").license);
  });
});
