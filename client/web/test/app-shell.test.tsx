// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  agentModels: vi.fn(),
  getSettings: vi.fn(),
  listLocalAgents: vi.fn(),
  listLocalAgentsDetected: vi.fn(),
  createRequirementsProjectSession: vi.fn(),
  createRequirementsSession: vi.fn(),
  getSession: vi.fn(),
  inspectLocalDir: vi.fn(),
  listRequirements: vi.fn(),
  listRequirementsMappings: vi.fn(),
  listRequirementsProjects: vi.fn(),
  listProjectRooms: vi.fn(),
  loginRequirements: vi.fn(),
  logoutRequirements: vi.fn(),
  registerRequirements: vi.fn(),
  requirementsSettings: vi.fn(),
  runDoctor: vi.fn(),
}));

const toastMocks = vi.hoisted(() => {
  const toast = vi.fn();
  return { toast, success: vi.fn(), error: vi.fn() };
});

vi.mock("../src/api/client.js", () => ({
  api: apiMocks,
  ApiClientError: class ApiClientError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("sonner", () => ({
  toast: Object.assign(toastMocks.toast, { success: toastMocks.success, error: toastMocks.error, warning: vi.fn() }),
  Toaster: () => null,
}));

vi.mock("../src/features/requirements/RequirementsPage.js", () => ({
  RequirementsPage: (props: { projectId: string }) => <div data-testid="requirements-stub" data-project={props.projectId} />,
  validateRequirementsSearch: (search: Record<string, unknown>) =>
    typeof search["status"] === "string" ? { status: search["status"] } : {},
}));
vi.mock("../src/features/requirements/RequirementDetailPage.js", () => ({
  RequirementDetailPage: (props: { projectId: string; numberRef: string }) => (
    <div data-testid="requirement-detail-stub" data-project={props.projectId} data-number={props.numberRef} />
  ),
}));
vi.mock("../src/features/my-work/MyWorkPage.js", () => ({
  MyWorkPage: () => <h1>我的工作</h1>,
  validateMyWorkSearch: () => ({}),
}));
vi.mock("../src/features/overview/OverviewPage.js", () => ({
  OverviewPage: (props: { projectId: string }) => <div data-testid="overview-stub" data-project={props.projectId} />,
  validateOverviewSearch: () => ({}),
}));
vi.mock("../src/features/sessions/SessionsPage.js", async () => {
  const { useSessionLauncher } = await import("../src/app/shell/SessionLauncher.js");
  const { useCurrentProject } = await import("../src/app/project-context.js");
  return {
    // 与真实会话页的「新建」同一路径：用当前项目发起项目会话。
    SessionsPage: (props: { session: { id: string } | null }) => {
      const launcher = useSessionLauncher();
      const { project } = useCurrentProject();
      return (
        <div data-testid="sessions-stub" data-session={props.session?.id ?? ""} data-project={project?.id ?? ""}>
          <button type="button" onClick={() => project !== null && launcher.launch({ kind: "project", remoteProjectId: project.id })}>
            新建项目会话
          </button>
        </div>
      );
    },
  };
});
vi.mock("../src/features/rooms/RoomsPage.js", () => ({
  RoomsPage: (props: { projectId: string; roomId: string | null; search: { thread?: string; run?: string } }) => (
    <div
      data-testid="rooms-stub"
      data-project={props.projectId}
      data-room={props.roomId ?? ""}
      data-thread={props.search.thread ?? ""}
      data-run={props.search.run ?? ""}
    />
  ),
  validateRoomsSearch: (search: Record<string, unknown>) => ({
    ...(typeof search["thread"] === "string" ? { thread: search["thread"] } : {}),
    ...(typeof search["thread"] === "string" && typeof search["run"] === "string" ? { run: search["run"] } : {}),
  }),
}));
vi.mock("../src/features/settings/SettingsPage.js", () => ({
  SettingsPage: (props: { section: string }) => <div data-testid="settings-stub" data-section={props.section} />,
}));

import { AppRoot } from "../src/app/AppRoot.js";
import { LoginForm } from "../src/app/pages/LoginForm.js";
import { createQueryClient, queryKeys } from "../src/app/queries.js";
import { clearPageFeedback, getPageFeedback } from "../src/feedback/page-store.js";
import { reportFailure } from "../src/feedback/report.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const user = { id: "u1", loginName: "sue", displayName: "Sue", createdAt: "2026-08-25T00:00:00.000Z" };
const project = {
  id: "p1",
  name: "订单中心",
  isArchived: false,
  createdBy: { id: "u1", displayName: "Sue" },
  updatedBy: { id: "u1", displayName: "Sue" },
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  version: 1,
};

const signedIn = () => ({
  configured: true,
  baseUrl: "https://requirements.example.com",
  session: { user, expiresAt: "2026-10-28T00:00:00.000Z" },
  mappingCount: 0,
});
const signedOut = () => ({ ...signedIn(), session: null });

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

/** 路由与查询都是异步的：多轮让出事件循环直到界面稳定。 */
async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function localAgent(id: string, displayName: string, usable: boolean) {
  return {
    id,
    displayName,
    vendor: "v",
    channel: id === "codex" ? "codex-app-server" : id === "claude-code" ? "claude-sdk" : "acp",
    bundled: id === "codex",
    runtimeAvailable: true,
    enabled: true,
    status: usable ? "ready" : "auth_required",
    reasonCode: null,
    reasonDetail: null,
    version: null,
    minVersion: null,
    verifiedVersion: null,
    executablePath: null,
    actions: [],
    capabilities: [],
    readOnlyCapable: id !== "gemini",
    homepageUrl: "https://x.test",
    termsUrl: null,
    checkedAt: 1,
  };
}

async function renderApp(path: string): Promise<HTMLDivElement> {
  window.history.replaceState({}, "", path);
  const node = await render(<AppRoot />);
  await settle();
  return node;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const locationOf = () => `${window.location.pathname}${window.location.search}`;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  apiMocks.createRequirementsProjectSession.mockResolvedValue({ id: "s1", projectId: "local-1" });
  // 默认只有 Codex 能用：开工不多问一步（多 Agent S5）。
  apiMocks.listLocalAgents.mockResolvedValue({ defaultAgentId: "codex", agents: [localAgent("codex", "Codex", true)] });
  apiMocks.agentModels.mockResolvedValue({ models: [], items: [] });
  apiMocks.getSettings.mockResolvedValue({ defaultApprovalMode: "ask", approvalModeLocked: false });
  apiMocks.createRequirementsSession.mockResolvedValue({ id: "s1", projectId: "local-1" });
  apiMocks.getSession.mockResolvedValue({ id: "s1", projectId: "local-1" });
  apiMocks.listRequirements.mockResolvedValue({ items: [], nextCursor: null });
  apiMocks.listRequirementsMappings.mockResolvedValue({ items: [] });
  apiMocks.inspectLocalDir.mockResolvedValue({ path: "/code/p1", exists: true, isDirectory: true, readable: true, writable: true, isGitRepo: true, branch: "main", linkedRemoteProjectIds: [] });
  apiMocks.listRequirementsProjects.mockResolvedValue({ items: [project], nextCursor: null });
  apiMocks.listProjectRooms.mockResolvedValue({ items: [] });
  apiMocks.loginRequirements.mockResolvedValue({ user, expiresAt: "2026-10-28T00:00:00.000Z" });
  apiMocks.logoutRequirements.mockResolvedValue(undefined);
  apiMocks.registerRequirements.mockResolvedValue({ user, expiresAt: "2026-10-28T00:00:00.000Z" });
  apiMocks.requirementsSettings.mockResolvedValue(signedIn());
  apiMocks.runDoctor.mockResolvedValue({ status: "PASS", checks: [] });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  clearPageFeedback();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("应用壳：反馈收口", () => {
  it("409 AUTH_INVALID 显示可用的「去登录」，点击后登出、清除页面失败并回到登录页", async () => {
    await renderApp("/my");
    apiMocks.requirementsSettings.mockResolvedValue(signedOut());

    await act(async () => reportFailure({ status: 409, code: "AUTH_INVALID" }, { surface: "action" }));
    const action = document.querySelector<HTMLButtonElement>('[data-testid="page-failure"] button');
    expect(action?.disabled).toBe(false);

    await act(async () => action?.click());
    await settle();
    expect(apiMocks.logoutRequirements).toHaveBeenCalledTimes(1);
    expect(getPageFeedback()).toBeNull();
    expect(window.location.pathname).toBe("/login");
  });

  it("登录成功会清除已有页面失败并进入工作台", async () => {
    apiMocks.requirementsSettings.mockResolvedValueOnce(signedOut());
    const node = await renderApp("/my");
    expect(window.location.pathname).toBe("/login");
    reportFailure({ status: 401, code: "AUTH_INVALID" }, { surface: "action" });

    await act(async () => {
      setInputValue(node.querySelector<HTMLInputElement>("#requirements-login-name")!, "sue");
      setInputValue(node.querySelector<HTMLInputElement>("#requirements-password")!, "secret");
    });
    const submit = Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "登录" && button.type === "submit");
    await act(async () => submit?.click());
    await settle();
    expect(apiMocks.loginRequirements).toHaveBeenCalledWith({ loginName: "sue", password: "secret" });
    expect(getPageFeedback()).toBeNull();
    expect(window.location.pathname).toBe("/my");
  });

  it("登录失败在表单内渲染 InlineError", async () => {
    apiMocks.loginRequirements.mockRejectedValue({ status: 400, code: "VALIDATION_ERROR" });
    const node = await render(
      <QueryClientProvider client={createQueryClient()}>
        <LoginForm onAuthenticated={vi.fn()} />
      </QueryClientProvider>,
    );
    await act(async () => {
      setInputValue(node.querySelector<HTMLInputElement>("#requirements-login-name")!, "sue");
      setInputValue(node.querySelector<HTMLInputElement>("#requirements-password")!, "wrong");
    });
    await act(async () => node.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    await settle(2);
    const error = node.querySelector('[data-testid="inline-error"]');
    expect(error?.getAttribute("data-feedback-kind")).toBe("validation");
    expect(error?.getAttribute("data-feedback-result")).toBe("field");
  });

  it("没有项目时需求与概览入口禁用并说明原因，不弹 toast", async () => {
    apiMocks.listRequirementsProjects.mockResolvedValue({ items: [], nextCursor: null });
    const node = await renderApp("/my");
    const labels = Array.from(node.querySelectorAll('[aria-disabled="true"]')).map((element) => element.getAttribute("aria-label") ?? "");
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(/^需求（还没有项目/);
    expect(labels[1]).toMatch(/^讨论（还没有项目/);
    expect(labels[2]).toMatch(/^概览（还没有项目/);
    expect(toastMocks.toast).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("裸 TypeError 的错误 toast 文案不归因本机 BFF 故障", async () => {
    apiMocks.logoutRequirements.mockRejectedValue(new TypeError("network failed"));
    await renderApp("/my");
    await act(async () => reportFailure({ status: 401, code: "AUTH_INVALID" }, { surface: "action" }));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="page-failure"] button')?.click());
    await settle(2);
    const message = toastMocks.error.mock.calls.at(-1)?.[0] as ReactElement<{ children: unknown }> | undefined;
    expect(String(message?.props.children)).not.toMatch(/网络|启动|CORS|防火墙|代理/);
    expect(String(message?.props.children)).toContain("暂时无法连接工作台");
  });
});

describe("应用壳：路由与拦截", () => {
  it("需求服务未配置时进入首启向导", async () => {
    apiMocks.requirementsSettings.mockResolvedValue({ configured: false, baseUrl: null, session: null, mappingCount: 0 });
    const node = await renderApp("/p/p1/requirements");
    expect(window.location.pathname).toBe("/setup");
    expect(node.textContent).toContain("连接团队的需求服务");
  });

  it("未登录时进入登录页，并记住原本要去的地址", async () => {
    apiMocks.requirementsSettings.mockResolvedValue(signedOut());
    await renderApp("/p/p1/overview");
    expect(window.location.pathname).toBe("/login");
    expect(new URLSearchParams(window.location.search).get("redirect")).toBe("/p/p1/overview");
  });

  it.each([
    ["/", "/my"],
    ["/?sessionId=s1&projectId=local-1", "/sessions/s1"],
    ["/sessions?sessionId=s1&projectId=local-1", "/sessions/s1"],
    ["/requirements", "/p/p1/requirements"],
    ["/requirements?status=in_testing", "/p/p1/requirements?status=in_testing"],
    ["/requirements/r9", "/p/p1/requirements/r9"],
    ["/overview", "/p/p1/overview"],
    ["/no-such-page", "/my"],
  ])("旧路径 %s 重定向到 %s", async (from, to) => {
    await renderApp(from);
    expect(locationOf()).toBe(to);
  });

  it("项目不存在时换到可用项目的同一分区", async () => {
    await renderApp("/p/missing/overview");
    expect(locationOf()).toBe("/p/p1/overview");
  });

  it("会话深链接解析出本机项目后交给会话页", async () => {
    const node = await renderApp("/sessions/s1");
    expect(node.querySelector('[data-testid="sessions-stub"]')?.getAttribute("data-session")).toBe("s1");
  });

  it("/p/$projectId 不带分区时进入需求看板", async () => {
    await renderApp("/p/p1");
    expect(locationOf()).toBe("/p/p1/requirements");
  });

  it("设置按分组路由：/settings 落到上次的分组，旧版 /settings#组 与未知分组都重定向", async () => {
    let node = await renderApp("/settings");
    expect(locationOf()).toBe("/settings/appearance");
    expect(node.querySelector('[data-testid="settings-stub"]')?.getAttribute("data-section")).toBe("appearance");
    await act(async () => root?.unmount());
    container?.remove();

    await renderApp("/settings#security");
    expect(locationOf()).toBe("/settings/execution");
    await act(async () => root?.unmount());
    container?.remove();

    await renderApp("/settings/nope");
    expect(locationOf()).toBe("/settings/appearance");
    await act(async () => root?.unmount());
    container?.remove();

    localStorage.setItem("suduo.settings.section", "mcp");
    node = await renderApp("/settings");
    expect(locationOf()).toBe("/settings/mcp");
    expect(node.querySelector('[data-testid="settings-stub"]')?.getAttribute("data-section")).toBe("mcp");
  });

  it("应用内跳到旧版 /settings#组 时不丢锚点", async () => {
    await renderApp("/my");
    await act(async () => {
      window.history.pushState({}, "", "/settings#proxy");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (let index = 0; index < 5; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(locationOf()).toBe("/settings/proxy");
  });

  it("讨论：房间与话题、运行详情都在地址里；项目不存在时换到可用项目的讨论", async () => {
    let node = await renderApp("/p/p1/rooms/room-1?thread=m-2&run=run-1");
    const stub = node.querySelector('[data-testid="rooms-stub"]');
    expect([stub?.getAttribute("data-project"), stub?.getAttribute("data-room"), stub?.getAttribute("data-thread"), stub?.getAttribute("data-run")]).toEqual([
      "p1",
      "room-1",
      "m-2",
      "run-1",
    ]);
    // 讨论页窄屏下侧栏自动收起：当前项只剩图标，名字在可访问名里。
    expect(node.querySelector('a[aria-current="page"]')?.getAttribute("aria-label")).toBe("讨论");
    await act(async () => root?.unmount());
    container?.remove();

    node = await renderApp("/p/missing/rooms/room-9");
    expect(locationOf()).toBe("/p/p1/rooms");
    expect(node.querySelector('[data-testid="rooms-stub"]')?.getAttribute("data-room")).toBe("");
  });

  it("左上角切换项目：讨论页跟到新项目的讨论；会话页收起上一个项目的会话、保留筛选", async () => {
    const other = { ...project, id: "p2", name: "支付中心" };
    apiMocks.listRequirementsProjects.mockResolvedValue({ items: [project, other], nextCursor: null });
    localStorage.setItem("suduo.sidebar.collapsed", "false");
    // 项目列表（cmdk）打开时把选中项滚进视野；jsdom 没有这个方法。
    const proto = Element.prototype as { scrollIntoView?: () => void };
    proto.scrollIntoView = () => undefined;
    const pick = async (name: string) => {
      await act(async () => document.querySelector<HTMLElement>('[data-testid="project-switcher"]')?.click());
      await settle();
      const item = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((element) => element.getAttribute("data-value")?.startsWith(`${name} `));
      expect(item, name).toBeDefined();
      await act(async () => item?.click());
      await settle();
    };
    try {
      let node = await renderApp("/p/p1/rooms/room-1?thread=m-2");
      await pick("支付中心");
      expect(locationOf()).toBe("/p/p2/rooms");
      expect(node.querySelector('[data-testid="rooms-stub"]')?.getAttribute("data-project")).toBe("p2");
      await act(async () => root?.unmount());
      container?.remove();

      node = await renderApp("/sessions/s1?filter=running");
      await pick("订单中心");
      expect(locationOf()).toBe("/sessions?filter=running");
      expect(node.querySelector('[data-testid="sessions-stub"]')?.getAttribute("data-project")).toBe("p1");
    } finally {
      delete proto.scrollIntoView;
    }
  });

  it("左上角选中的就是当前项目：不跳转，但记住这次选择", async () => {
    localStorage.removeItem("suduo.v2.remoteProjectId");
    localStorage.setItem("suduo.sidebar.collapsed", "false");
    const proto = Element.prototype as { scrollIntoView?: () => void };
    proto.scrollIntoView = () => undefined;
    try {
      await renderApp("/sessions");
      await act(async () => document.querySelector<HTMLElement>('[data-testid="project-switcher"]')?.click());
      await settle();
      const item = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((element) => element.getAttribute("data-value")?.startsWith("订单中心 "));
      expect(item).toBeDefined();
      await act(async () => item?.click());
      await settle();
      expect(locationOf()).toBe("/sessions");
      expect(localStorage.getItem("suduo.v2.remoteProjectId")).toBe("p1");
    } finally {
      delete proto.scrollIntoView;
    }
  });

  it("侧栏「讨论」显示当前项目房间的未读合计（不含归档）", async () => {
    const viewer = (unreadCount: number) => ({ joined: true, lastReadSeq: 0, unreadCount, mentionCount: 0 });
    apiMocks.listProjectRooms.mockResolvedValue({
      items: [
        { id: "room-1", projectId: "p1", kind: "project_default", name: "订单中心", archivedAt: null, viewer: viewer(2) },
        { id: "room-2", projectId: "p1", kind: "requirement", name: "REQ-1 讨论", archivedAt: null, viewer: viewer(3) },
        { id: "room-3", projectId: "p1", kind: "requirement", name: "REQ-7 联调", archivedAt: "2026-09-01T00:00:00.000Z", viewer: viewer(9) },
      ],
    });
    localStorage.setItem("suduo.sidebar.collapsed", "false");
    const node = await renderApp("/p/p1/requirements");
    expect(apiMocks.listProjectRooms).toHaveBeenCalledWith("p1", expect.anything());
    expect(node.querySelector('[data-testid="rooms-unread"]')?.textContent).toBe("5");
    expect(node.querySelector('a[aria-label="讨论，5 条未读"]')?.getAttribute("href")).toBe("/p/p1/rooms");
  });

  it("没有项目时会话页仍可用（不会卡在骨架屏）", async () => {
    apiMocks.listRequirementsProjects.mockResolvedValue({ items: [], nextCursor: null });
    const node = await renderApp("/sessions");
    expect(node.querySelector('[data-testid="sessions-stub"]')?.getAttribute("data-project")).toBe("");
  });
});

describe("应用壳：稳健性", () => {
  it("设置在后台刷新失败时保留已有界面，不整页替换为启动失败", async () => {
    const queryClient = createQueryClient();
    window.history.replaceState({}, "", "/my");
    const node = await render(<AppRoot queryClient={queryClient} />);
    await settle();
    apiMocks.requirementsSettings.mockRejectedValue(new TypeError("down"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.settings }).catch(() => undefined);
    });
    await settle();
    expect(node.querySelector('[data-testid="app-nav"]')).not.toBeNull();
    expect(node.textContent).not.toContain("连不上本机的 SuDuo 服务");
  });

  it("页面级失败显示在内容面板里", async () => {
    const node = await renderApp("/my");
    await act(async () => reportFailure({ status: 503, code: "UPSTREAM_UNAVAILABLE" }, { surface: "page", retry: () => undefined }));
    expect(node.querySelector('#main-content [data-testid="page-failure"]')).not.toBeNull();
  });

  it("能用的 Agent 不止一家：开工前先选 Agent 与权限，按选的建会话（多 Agent S5）", async () => {
    apiMocks.listRequirementsMappings.mockResolvedValue({
      items: [{ remoteProjectId: "p1", localProjectId: "local-1", rootPath: "/code/p1" }],
    });
    apiMocks.listLocalAgents.mockResolvedValue({
      defaultAgentId: "claude-code",
      agents: [localAgent("codex", "Codex", true), localAgent("claude-code", "Claude Code", true), localAgent("gemini", "Gemini CLI", false)],
    });
    apiMocks.createRequirementsProjectSession.mockResolvedValue({ id: "s7", projectId: "local-1" });
    const node = await renderApp("/sessions");
    const button = Array.from(node.querySelectorAll("button")).find((item) => item.textContent === "新建项目会话");
    await act(async () => button?.click());
    await settle(3);
    expect(document.querySelector('[data-testid="start-options"]')).not.toBeNull();
    expect(apiMocks.createRequirementsProjectSession).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="start-options-confirm"]')?.click());
    await settle(3);
    expect(apiMocks.createRequirementsProjectSession).toHaveBeenCalledWith("p1", { agentId: "claude-code", model: null, reasoningEffort: null });
    expect(window.localStorage.getItem("suduo.lastAgentId")).toBe("claude-code");
  });

  it("刚启动、还在检测时等检测完再决定：最后只有一家能用就直接开工（gate-c 的情形）", async () => {
    apiMocks.listRequirementsMappings.mockResolvedValue({
      items: [{ remoteProjectId: "p1", localProjectId: "local-1", rootPath: "/code/p1" }],
    });
    apiMocks.listLocalAgents.mockResolvedValue({
      defaultAgentId: "codex",
      agents: [localAgent("codex", "Codex", true), { ...localAgent("claude-code", "Claude Code", true), status: "checking" }],
    });
    apiMocks.listLocalAgentsDetected.mockResolvedValue({
      defaultAgentId: "codex",
      agents: [localAgent("codex", "Codex", true), { ...localAgent("claude-code", "Claude Code", false), status: "not_installed" }],
    });
    apiMocks.createRequirementsProjectSession.mockResolvedValue({ id: "s8", projectId: "local-1" });
    const node = await renderApp("/sessions");
    const button = Array.from(node.querySelectorAll("button")).find((item) => item.textContent === "新建项目会话");
    await act(async () => button?.click());
    await settle(4);
    expect(document.querySelector('[data-testid="start-options"]')).toBeNull();
    expect(apiMocks.createRequirementsProjectSession).toHaveBeenCalledWith("p1", { agentId: "codex" });
  });

  it("连点发起项目会话只会创建一个会话", async () => {
    apiMocks.listRequirementsMappings.mockResolvedValue({
      items: [{ remoteProjectId: "p1", localProjectId: "local-1", rootPath: "/code/p1" }],
    });
    let resolveCreate: (value: { id: string; projectId: string }) => void = () => undefined;
    apiMocks.createRequirementsProjectSession.mockImplementation(
      () => new Promise((resolve) => (resolveCreate = resolve)),
    );
    const node = await renderApp("/sessions");
    const button = Array.from(node.querySelectorAll("button")).find((item) => item.textContent === "新建项目会话");
    await act(async () => {
      button?.click();
      button?.click();
      button?.click();
    });
    await settle(3);
    resolveCreate({ id: "s9", projectId: "local-1" });
    await settle();
    expect(apiMocks.createRequirementsProjectSession).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/sessions/s9");
  });

  it("会话页自动收起的侧栏，一次点击即可展开", async () => {
    localStorage.setItem("suduo.sidebar.collapsed", "true");
    const node = await renderApp("/sessions");
    const expand = node.querySelector<HTMLButtonElement>('button[aria-label="展开侧栏"]');
    expect(expand).not.toBeNull();
    await act(async () => expand?.click());
    expect(node.querySelector('button[aria-label="收起侧栏"]')).not.toBeNull();
  });
});
