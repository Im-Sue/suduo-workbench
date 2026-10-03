// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  codexModels: vi.fn(),
  codexStatusUrl: vi.fn(),
  createMcpServer: vi.fn(),
  getSettings: vi.fn(),
  globalSkills: vi.fn(),
  installSkill: vi.fn(),
  listMcpServers: vi.fn(),
  listRequirementsMappingsVerified: vi.fn(),
  loginMcpServer: vi.fn(),
  logoutMcpServer: vi.fn(),
  modelProvider: vi.fn(),
  refreshMcpServers: vi.fn(),
  removeMcpServer: vi.fn(),
  removeSkill: vi.fn(),
  requirementsSettings: vi.fn(),
  setSkillEnabled: vi.fn(),
  skillCatalog: vi.fn(),
  updateMcpServer: vi.fn(),
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
  menuItem,
  MockEventSource,
  modelProviderSettings,
  openMenu,
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

function mapping(localProjectId: string, name: string) {
  return {
    remoteProjectId: `r-${localProjectId}`,
    localProjectId,
    rootPath: `/code/${localProjectId}`,
    localProjectName: name,
    lastValidatedAt: 0,
    verification: { exists: true, readable: true, writable: true, executable: true, available: true, message: "" },
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  apiMocks.codexModels.mockResolvedValue({ models: [], items: [] });
  apiMocks.codexStatusUrl.mockReturnValue("/api/v1/codex/status");
  apiMocks.createMcpServer.mockResolvedValue({ atomic: true, message: "ok" });
  apiMocks.getSettings.mockResolvedValue(localSettings());
  apiMocks.globalSkills.mockResolvedValue({ items: [], root: "/tmp/skills" });
  apiMocks.installSkill.mockResolvedValue({});
  apiMocks.listMcpServers.mockResolvedValue({ items: [], statusAvailable: true });
  apiMocks.listRequirementsMappingsVerified.mockResolvedValue({ items: [] });
  apiMocks.loginMcpServer.mockResolvedValue({ authorizationUrl: "https://example.com/auth" });
  apiMocks.logoutMcpServer.mockResolvedValue(undefined);
  apiMocks.modelProvider.mockResolvedValue(modelProviderSettings());
  apiMocks.refreshMcpServers.mockResolvedValue({ items: [], statusAvailable: true });
  apiMocks.removeMcpServer.mockResolvedValue(undefined);
  apiMocks.removeSkill.mockResolvedValue(undefined);
  apiMocks.requirementsSettings.mockResolvedValue(requirementsSettings());
  apiMocks.setSkillEnabled.mockResolvedValue(undefined);
  apiMocks.skillCatalog.mockResolvedValue({ items: [] });
  apiMocks.updateMcpServer.mockResolvedValue({ atomic: true, message: "ok" });
  apiMocks.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => localSettings(patch));
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

describe("MCP 服务", () => {
  it("列表拿不到连接信息时只呈现「未确认连接」，不编造原因", async () => {
    apiMocks.listMcpServers.mockResolvedValue({
      items: [mcpServer({ status: { ...mcpServer().status, startupState: "unknown" } })],
      statusAvailable: true,
    });
    const { node } = await open("/settings/mcp");
    await click(buttonByText(node, "查看原因"));
    const detail = node.querySelector('[data-testid="mcp-failure-detail"]');
    expect(detail?.textContent).toContain("未确认连接");
    expect(detail?.textContent).toContain("Codex 没有提供");
    expect(detail?.textContent).not.toMatch(/启动失败|尚未启动|命令路径|环境变量未设置/);
  });

  it("删除 MCP 默认聚焦取消，取消不调用删除接口", async () => {
    apiMocks.listMcpServers.mockResolvedValue({ items: [mcpServer()], statusAvailable: true });
    const { node } = await open("/settings/mcp");
    await openMenu(node.querySelector('[aria-label="「filesystem」的更多操作"]'));
    await click(menuItem("删除"));
    const dialog = document.querySelector('[data-testid="confirm-dialog"]');
    const cancel = buttonByText(dialog ?? document, "取消");
    expect(document.activeElement).toBe(cancel);
    await click(cancel);
    expect(apiMocks.removeMcpServer).not.toHaveBeenCalled();
  });

  it("测试连接进行中声明 aria-busy，一秒后提示仍在测试；结果分成功 / 失败样式", async () => {
    apiMocks.listMcpServers.mockResolvedValue({ items: [mcpServer()], statusAvailable: true });
    let resolveRefresh: ((value: unknown) => void) | null = null;
    apiMocks.refreshMcpServers.mockReturnValue(new Promise((resolve) => (resolveRefresh = resolve)));
    const { node } = await open("/settings/mcp");
    vi.useFakeTimers();
    await act(async () => buttonByText(node, "测试连接")?.click());
    expect(node.querySelector('[data-testid="mcp-panel"]')?.getAttribute("aria-busy")).toBe("true");
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(node.textContent).toContain("仍在测试");
    vi.useRealTimers();
    await act(async () =>
      resolveRefresh?.({ items: [mcpServer({ status: { ...mcpServer().status, startupState: "failed" } })], statusAvailable: true }),
    );
    await settle();
    const result = node.querySelector('[data-testid="settings-test-result"]');
    expect(result?.getAttribute("data-result")).toBe("failure");
    expect(result?.textContent).toContain("「filesystem」");
    expect(node.querySelector('[data-testid="mcp-panel"]')?.getAttribute("aria-busy")).toBe("false");
  });

  it("启用开关先改界面，失败回滚并提示可重试", async () => {
    apiMocks.listMcpServers.mockResolvedValue({ items: [mcpServer()], statusAvailable: true });
    apiMocks.updateMcpServer.mockRejectedValueOnce({ status: 500, code: "INTERNAL_ERROR", message: "写入失败" });
    const { node } = await open("/settings/mcp");
    const toggle = node.querySelector<HTMLButtonElement>('[data-testid="mcp-enabled"]');
    await click(toggle);
    await settle();
    expect(apiMocks.updateMcpServer).toHaveBeenCalledWith("filesystem", { enabled: false });
    expect(node.querySelector('[data-testid="mcp-enabled"]')?.getAttribute("aria-checked")).toBe("true");
    expect(toastMocks.error).toHaveBeenCalled();
  });

  it("添加服务只收变量名、不收密钥；名称不合规时不提交", async () => {
    const { node } = await open("/settings/mcp");
    await click(node.querySelector('[data-testid="mcp-add"]'));
    const form = document.querySelector('[data-testid="mcp-create-form"]');
    expect(form?.textContent).toContain("只填变量名");
    await act(async () => setInputValue(document.querySelector('[data-testid="mcp-name"]'), "1bad"));
    await act(async () => setInputValue(document.querySelector('[data-testid="mcp-command"]'), "/opt/db-mcp"));
    await click(document.querySelector('[data-testid="mcp-create-submit"]'));
    expect(apiMocks.createMcpServer).not.toHaveBeenCalled();
    await act(async () => setInputValue(document.querySelector('[data-testid="mcp-name"]'), "db"));
    await act(async () => setInputValue(document.querySelector('[data-testid="mcp-env-vars"]'), "DB_TOKEN, DB_HOST"));
    await click(document.querySelector('[data-testid="mcp-create-submit"]'));
    expect(apiMocks.createMcpServer).toHaveBeenCalledWith({
      name: "db",
      transport: { type: "stdio", command: "/opt/db-mcp", args: [], envVars: ["DB_TOKEN", "DB_HOST"] },
    });
  });

  it("没有服务时用 EmptyState 引导添加", async () => {
    const { node } = await open("/settings/mcp");
    const state = node.querySelector('[data-testid="empty-state"]');
    expect(state?.textContent).toContain("MCP 服务");
  });
});

describe("Skills", () => {
  it("卸载 Skill 默认聚焦取消，取消不调用卸载接口", async () => {
    apiMocks.globalSkills.mockResolvedValue({ items: [{ name: "lint", path: "/tmp/lint", description: "Lint" }], root: "/tmp/skills" });
    const { node } = await open("/settings/skills");
    await click(buttonByText(node, "卸载"));
    const dialog = document.querySelector('[data-testid="confirm-dialog"]');
    const cancel = buttonByText(dialog ?? document, "取消");
    expect(document.activeElement).toBe(cancel);
    await click(cancel);
    expect(apiMocks.removeSkill).not.toHaveBeenCalled();
  });

  it("多个项目且未选择时展示行内引导，不发送提示", async () => {
    apiMocks.listRequirementsMappingsVerified.mockResolvedValue({ items: [mapping("p1", "项目一"), mapping("p2", "项目二")] });
    const { node } = await open("/settings/skills");
    const guide = node.querySelector('[data-testid="skills-project-context-required"]');
    expect(guide?.getAttribute("role")).toBe("status");
    expect(guide?.textContent).toContain("选择项目后");
    expect(toastMocks.error).not.toHaveBeenCalled();
    expect(toastMocks.toast).not.toHaveBeenCalled();
    expect(apiMocks.skillCatalog).not.toHaveBeenCalled();
  });

  it("只有一个项目时自动选择，并按项目显示启用开关", async () => {
    apiMocks.listRequirementsMappingsVerified.mockResolvedValue({ items: [mapping("p1", "项目一")] });
    apiMocks.globalSkills.mockResolvedValue({ items: [{ name: "lint", path: "/tmp/lint", description: "Lint" }], root: "/tmp/skills" });
    apiMocks.skillCatalog.mockResolvedValue({ items: [{ name: "lint", description: "Lint", path: "/tmp/lint", scope: "user", enabled: true }] });
    const { node } = await open("/settings/skills");
    await settle();
    expect(apiMocks.skillCatalog).toHaveBeenCalledWith("p1");
    expect(node.querySelector('[data-testid="skill-scope"]')?.textContent).toBe("个人");
    await click(node.querySelector('[aria-label="启用 lint"]'));
    expect(apiMocks.setSkillEnabled).toHaveBeenCalledWith("lint", false);
  });

  it("没有 Skill、缺少项目上下文都使用 EmptyState", async () => {
    const { node } = await open("/settings/skills");
    const states = [...node.querySelectorAll('[data-testid="empty-state"]')];
    expect(states).toHaveLength(2);
    expect(states[0]?.getAttribute("data-feedback-kind")).toBe("prerequisite");
    expect(states.map((state) => state.textContent).join(" ")).toContain("还没有安装任何 Skill");
  });

  it("读取 Skills 遇到 AUTH_INVALID 路由到页面级反馈", async () => {
    apiMocks.globalSkills.mockRejectedValue({ status: 409, code: "AUTH_INVALID" });
    await open("/settings/skills");
    const feedback = getPageFeedback();
    expect(feedback?.failure.kind).toBe("auth_expired");
    expect(feedback?.route.outlet).toBe("page");
  });

  it("个人 Skills 目录被管理员固定时开关不可用，并说明找谁", async () => {
    apiMocks.getSettings.mockResolvedValue(localSettings({ globalSkillsLocked: true }));
    const { node } = await open("/settings/skills");
    const toggle = node.querySelector<HTMLButtonElement>('[data-testid="settings-global-skills"]');
    expect(toggle?.disabled).toBe(true);
    expect(node.querySelector('[data-testid="settings-lock-reason"]')?.textContent).toContain("管理员");
    expect(node.textContent).not.toContain("SUDUO_GLOBAL_SKILLS");
  });
});
