// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  codexModels: vi.fn(),
  codexStatusUrl: vi.fn(),
  getSettings: vi.fn(),
  globalSkills: vi.fn(),
  listAllSessions: vi.fn(),
  listMcpServers: vi.fn(),
  listRequirementsMappingsVerified: vi.fn(),
  modelProvider: vi.fn(),
  requirementsSettings: vi.fn(),
  runDoctor: vi.fn(),
  skillCatalog: vi.fn(),
  updateSettings: vi.fn(),
}));

/** 界面已经做完的语言。迁移期真实值只有 zh-CN；这里换成可变数组，两种情况都能测。 */
const uiLocales = vi.hoisted(() => ["zh-CN", "en"] as ("zh-CN" | "en")[]);

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  Toaster: () => null,
}));

vi.mock("../src/i18n/locale.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  UI_LOCALES: uiLocales,
}));

import { parseArgs } from "../src/features/settings/mcp-edit.js";
import { applyLocalePreference, LOCALE_STORAGE_KEY } from "../src/i18n/locale.js";
import {
  buttonByText,
  click,
  localSettings,
  mcpServer,
  MockEventSource,
  modelProviderSettings,
  renderSettings,
  requirementsSettings,
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
  uiLocales.splice(0, uiLocales.length, "zh-CN", "en");
  apiMocks.codexModels.mockResolvedValue({ models: [], items: [] });
  apiMocks.codexStatusUrl.mockReturnValue("/api/v1/codex/status");
  apiMocks.getSettings.mockResolvedValue(localSettings());
  apiMocks.globalSkills.mockResolvedValue({ items: [], root: "/tmp/skills" });
  apiMocks.listAllSessions.mockResolvedValue({ items: [], nextCursor: null });
  apiMocks.listMcpServers.mockResolvedValue({ items: [], statusAvailable: true });
  apiMocks.listRequirementsMappingsVerified.mockResolvedValue({ items: [] });
  apiMocks.modelProvider.mockResolvedValue(modelProviderSettings());
  apiMocks.requirementsSettings.mockResolvedValue(requirementsSettings());
  apiMocks.runDoctor.mockResolvedValue({ status: "PASS", checks: [] });
  apiMocks.skillCatalog.mockResolvedValue({ items: [] });
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
  localStorage.clear();
});

describe("英文界面：MCP、Skills、执行、通知、外观", () => {
  beforeEach(() => {
    applyLocalePreference("en");
  });

  it("MCP：连接状态、工具数与没给原因时的说明", async () => {
    apiMocks.listMcpServers.mockResolvedValue({
      items: [
        mcpServer(),
        mcpServer({ name: "db", status: { ...mcpServer().status, name: "db", startupState: "failed" } }),
      ],
      statusAvailable: true,
    });
    const { node } = await open("/settings/mcp");
    expect(node.querySelector('[data-testid="mcp-add"]')?.textContent).toBe("Add server");
    const [ready, failed] = [...node.querySelectorAll('[data-testid="mcp-server-row"]')];
    expect(ready?.querySelector('[data-testid="mcp-startup-state"]')?.textContent).toBe("Connected");
    expect(ready?.textContent).toContain("Local command");
    expect(ready?.textContent).toContain(" · 3 tools");
    expect(failed?.querySelector('[data-testid="mcp-startup-state"]')?.textContent).toBe("Couldn't connect");
    expect(node.querySelector('[aria-label="More actions for “db”"]')).not.toBeNull();

    await click(buttonByText(node, "See why"));
    const detail = node.querySelector('[data-testid="mcp-failure-detail"]');
    expect(detail?.textContent).toContain("Codex didn't provide connection details for this server.");
    expect(detail?.textContent).toContain("Command: npx");
  });

  it("MCP：参数里的引号没配对时，报错按当前语言", () => {
    expect(parseArgs('--root "/Users/me')).toEqual({ ok: false, message: "A quote isn't closed. Check the arguments." });
  });

  it("Skills：空列表与安装入口", async () => {
    const { node } = await open("/settings/skills");
    expect(node.querySelector('[data-setting-row="global-skills"]')?.textContent).toContain("Folder: /tmp/skills");
    expect(node.querySelector('[data-testid="skills-project-context-empty"]')?.textContent).toContain("No local folder linked yet.");
    expect(node.querySelector('[data-setting-row="skill-list"] [data-testid="empty-state"]')?.textContent).toContain(
      "No Skills installed yet",
    );
    expect(buttonByText(node, "Install")).toBeDefined();
  });

  it("执行与安全：审批档名称与权限表", async () => {
    const { node } = await open("/settings/execution");
    expect(node.querySelector('[data-testid="settings-approval-ask"]')?.textContent).toContain("Ask every step");
    expect(node.querySelector('[data-testid="settings-approval-auto"]')?.textContent).toContain("Recommended");
    const table = node.querySelector('table[aria-label="What each mode allows"]');
    expect(table?.textContent).toContain("Full access");
    expect(node.querySelector('[data-testid="settings-full-allowed"]')?.textContent).toBe("Yes");
  });

  it("通知：浏览器不支持时说明标签页提醒仍然有效", async () => {
    vi.stubGlobal("Notification", undefined);
    const { node } = await open("/settings/notifications");
    expect(node.querySelector('[data-setting-row="system-notify"]')?.textContent).toContain("System notifications");
    expect(node.textContent).toContain("This browser doesn't support system notifications.");
  });

  it("外观：主题与密度选项", async () => {
    const { node } = await open("/settings/appearance");
    const theme = node.querySelector('[data-testid="settings-theme"]');
    const labels = [...(theme?.querySelectorAll("[aria-label]") ?? [])].map((tile) => tile.getAttribute("aria-label"));
    expect(labels).toEqual(["Light", "Dark", "System (recommended)"]);
    expect(node.querySelector('[data-testid="settings-density"]')?.textContent).toBe("ComfortableCompact");
  });
});

describe("外观 · 语言", () => {
  it("有两种以上界面语言时出现语言选项，选 English 立即生效并记住", async () => {
    const { node } = await open("/settings/appearance");
    const row = node.querySelector('[data-setting-row="locale"]');
    expect(row?.textContent).toContain("语言");
    expect(row?.textContent).toContain("切换语言会重新载入当前页面");
    const control = node.querySelector('[data-testid="settings-locale"]');
    const options = [...(control?.querySelectorAll("button") ?? [])];
    expect(options.map((option) => option.textContent)).toEqual(["跟随系统", "简体中文", "English"]);
    expect(options[0]?.getAttribute("data-state")).toBe("on");

    await click(options.find((option) => option.textContent === "English"));
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(node.querySelector('[data-setting-row="locale"]')?.textContent).toContain("Language");
    expect(node.querySelector('[data-testid="settings-locale"] [data-state="on"]')?.textContent).toBe("English");
  });

  it("只有一种界面语言时（迁移期）不显示语言选项", async () => {
    uiLocales.splice(0, uiLocales.length, "zh-CN");
    const { node } = await open("/settings/appearance");
    expect(node.querySelector('[data-testid="settings-theme"]')).not.toBeNull();
    expect(node.querySelector('[data-setting-row="locale"]')).toBeNull();
    expect(node.querySelector('[data-testid="settings-locale"]')).toBeNull();
  });
});
