// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  requirementsSettings: vi.fn(),
  runDoctor: vi.fn(),
  listRequirementsProjects: vi.fn(),
  loginRequirements: vi.fn(),
  registerRequirements: vi.fn(),
  testRequirementsSettings: vi.fn(),
  updateRequirementsSettings: vi.fn(),
  createRequirementsProject: vi.fn(),
  saveRequirementsMapping: vi.fn(),
  listLocalAgents: vi.fn(),
  recheckAgent: vi.fn(),
  updateAgentSettings: vi.fn(),
}));

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

import { AppErrorBoundary } from "../src/app/AppErrorBoundary.js";
import { BootFailure, BootSplash } from "../src/app/pages/BootScreens.js";
import { summarizeDoctor } from "../src/app/pages/doctor-summary.js";
import { LoginPage } from "../src/app/pages/LoginPage.js";
import { SetupPage, validateSetupSearch } from "../src/app/pages/SetupPage.js";
import { readSetupPending, recordMappingPending } from "../src/app/pages/setup-pending.js";
import { applyLocalePreference } from "../src/i18n/locale.js";
import { messagesFor } from "../src/i18n/messages/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const user = { id: "u1", loginName: "sue", displayName: "Sue", createdAt: "2026-08-25T00:00:00.000Z" };
const signedIn = () => ({
  configured: true,
  baseUrl: "https://requirements.example.com",
  session: { user, expiresAt: "2026-10-28T00:00:00.000Z" },
  mappingCount: 0,
});

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 只挂登录页与首启向导的最小路由：真实的登录拦截由 app-shell 测试覆盖。 */
async function renderPage(path: string): Promise<HTMLDivElement> {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/setup",
      validateSearch: validateSetupSearch,
      component: SetupPage,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/my", component: () => <div data-testid="my-stub" /> }),
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const node = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await settle();
  return node;
}

const buttons = (node: HTMLElement) => [...node.querySelectorAll("button")].map((button) => button.textContent);

beforeEach(() => {
  applyLocalePreference("en");
  apiMocks.requirementsSettings.mockResolvedValue({ ...signedIn(), session: null });
  apiMocks.runDoctor.mockResolvedValue({ status: "PASS", checks: [] });
  apiMocks.listRequirementsProjects.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  applyLocalePreference("system");
  window.localStorage.clear();
});

describe("英文界面：登录页", () => {
  it("标题、服务地址与登录表单", async () => {
    const node = await renderPage("/login");
    expect(node.querySelector("main")?.getAttribute("aria-label")).toBe("Sign in to the requirements service");
    expect(node.querySelector("h1")?.textContent).toBe("Sign in to SuDuo");
    expect(node.textContent).toContain("Requirements service: https://requirements.example.com");
    expect(node.querySelector("a")?.textContent).toBe("Change");
    expect(node.querySelector("#requirements-login-name")?.getAttribute("placeholder")).toBe("e.g. alexchen");
    expect(buttons(node)).toContain("Create account");

    const submit = node.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit?.textContent).toBe("Sign in");
    await act(async () => submit?.click());
    expect(node.textContent).toContain("Enter your username");
    expect(node.textContent).toContain("Enter your password");
  });
});

describe("英文界面：首启向导", () => {
  it("第 1 步：连接需求服务", async () => {
    apiMocks.requirementsSettings.mockResolvedValue({ configured: false, baseUrl: null, session: null, mappingCount: 0 });
    const node = await renderPage("/setup");
    expect(node.textContent).toContain("Step 1 of 6");
    expect(node.querySelector("h2")?.textContent).toBe("Connect to your team's requirements service");
    expect(node.querySelector('ol[aria-label="Setup steps"]')?.textContent).toContain("Connect requirements service");
    expect(node.querySelector("input")?.getAttribute("placeholder")).toBe("e.g. http://192.168.1.10:4100");
    expect(buttons(node)).toEqual(expect.arrayContaining(["Test connection", "Next"]));
  });

  it("第 3 步：环境检查的汇总、单复数与留到「我的工作」的提醒", async () => {
    apiMocks.requirementsSettings.mockResolvedValue(signedIn());
    apiMocks.runDoctor.mockResolvedValue({
      status: "WARN",
      checks: [
        { id: "suduo.codex-cli", name: "Codex CLI", status: "pass", message: "codex-cli 0.159.2（workspace 锁定版本）", version: "0.159.2" },
        { id: "auth.credentials", name: "Codex · auth · auth.credentials", status: "fail", message: "no Codex credentials were found" },
      ],
    });
    const node = await renderPage("/setup?step=3");
    expect(node.textContent).toContain("Step 3 of 6");
    expect(node.textContent).toContain("Installed, version 0.159.2");
    expect(node.textContent).toContain("View all 2 checks");
    expect(node.textContent).toContain("1 item needs attention. You can continue and handle it later in Settings.");
    expect(buttons(node)).toEqual(expect.arrayContaining(["Back", "Check again", "Next"]));

    const next = [...node.querySelectorAll("button")].find((button) => button.textContent === "Next");
    await act(async () => next?.click());
    expect(readSetupPending().map((item) => item.title)).toEqual(["Model service"]);
  });

  it("第 4 步：连接 Agent（S12），可以直接下一步；第 6 步：完成页（路由认得第 6 步）", async () => {
    apiMocks.requirementsSettings.mockResolvedValue(signedIn());
    apiMocks.listLocalAgents.mockResolvedValue({
      defaultAgentId: "codex",
      agents: [
        { id: "codex", displayName: "Codex", vendor: "OpenAI", channel: "codex-app-server", bundled: true, runtimeAvailable: true, enabled: true, status: "ready", reasonCode: null, reasonDetail: null, version: "0.159.2", minVersion: null, verifiedVersions: ["0.159.2"], versionVerified: true, executablePath: "/x/codex", actions: [], capabilities: [], readOnlyCapable: true, homepageUrl: "https://openai.com", termsUrl: null, checkedAt: 1 },
      ],
    });
    const node = await renderPage("/setup?step=4");
    expect(node.textContent).toContain("Step 4 of 6");
    expect(node.querySelector("h2")?.textContent).toBe("Connect AI agents");
    expect(node.querySelector('[data-testid="agent-row-codex"]')).not.toBeNull();
    await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="setup-agents-next"]')?.click());
    expect(node.textContent).toContain("Step 5 of 6");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    const done = await renderPage("/setup?step=6");
    expect(done.textContent).toContain("Step 6 of 6");
    expect(done.textContent).toContain("You're all set");
  });
});

describe("英文界面：启动与兜底", () => {
  it("启动中与连不上本机服务", async () => {
    const node = await render(
      <>
        <BootSplash />
        <BootFailure error={new TypeError("Failed to fetch")} onRetry={() => undefined} />
      </>,
    );
    expect(node.textContent).toContain("Starting SuDuo");
    expect(node.querySelector("h1")?.textContent).toBe("Can't reach the local SuDuo service");
    expect(buttons(node)).toEqual(["Retry"]);
  });

  it("顶层错误边界", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Broken(): ReactElement {
      throw new Error("boom");
    }
    const node = await render(
      <AppErrorBoundary>
        <Broken />
      </AppErrorBoundary>,
    );
    expect(node.querySelector("h1")?.textContent).toBe("Something went wrong and this page can't be shown");
    expect(buttons(node)).toEqual(["Reload", "Clear local cache and reload"]);
  });
});

describe("英文界面：非组件文字", () => {
  it("环境检查汇总按调用时的语言取文字，也可由调用方传入字典", () => {
    const failing = [{ id: "suduo.node", name: "Node.js", status: "fail", message: "needs 24.10.0" }];
    expect(summarizeDoctor(failing).find((item) => item.key === "runtime")).toMatchObject({
      title: "Local runtime",
      detail: "Node.js: needs 24.10.0",
    });
    expect(summarizeDoctor(failing, messagesFor("zh-CN")).find((item) => item.key === "runtime")).toMatchObject({
      title: "本机运行环境",
      detail: "Node.js：needs 24.10.0",
    });
  });

  it("「稍后再关联」的提醒只存类型，文字按读取时的语言取", () => {
    recordMappingPending(true);
    expect(JSON.parse(localStorage.getItem("suduo.setup.pending") ?? "null")).toEqual([{ key: "mapping" }]);
    expect(readSetupPending()).toEqual([
      {
        key: "mapping",
        title: "Link local folder",
        detail: "SuDuo doesn't know where the project code is yet. Choose its folder before you start a session.",
      },
    ]);
  });
});
