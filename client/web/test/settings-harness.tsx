import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
  type AnyRouter,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "../src/features/settings/SettingsPage.js";
import type { SettingsSectionId } from "../src/features/settings/sections.js";

/**
 * 设置页测试的最小路由：/settings/$section + 登录 / 我的工作两个占位页。
 * 真实的外壳（侧栏、登录拦截）由 app-shell 测试覆盖，这里只关心设置页本身。
 */
export interface SettingsHarness {
  node: HTMLDivElement;
  router: AnyRouter;
  queryClient: QueryClient;
  pathname(): string;
  unmount(): Promise<void>;
}

function SectionRoute() {
  const { section } = useParams({ strict: false }) as { section: string };
  return <SettingsPage section={section as SettingsSectionId} />;
}

export async function renderSettings(path: string): Promise<SettingsHarness> {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/settings/$section", component: SectionRoute }),
    createRoute({ getParentRoute: () => rootRoute, path: "/login", component: () => <div data-testid="login-stub" /> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/my", component: () => <div data-testid="my-stub" /> }),
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const node = document.createElement("div");
  document.body.append(node);
  const root: Root = createRoot(node);
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await settle();
  return {
    node,
    router,
    queryClient,
    pathname: () => `${router.state.location.pathname}${router.state.location.hash === "" ? "" : `#${router.state.location.hash}`}`,
    unmount: async () => {
      await act(async () => root.unmount());
      node.remove();
      queryClient.clear();
    },
  };
}

/** 路由与查询都是异步的：多轮让出事件循环直到界面稳定。 */
export async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export function setInputValue(input: HTMLInputElement | null, value: string): void {
  if (input === null) throw new Error("input not found");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (element === null || element === undefined) throw new Error("element not found");
  await act(async () => (element as HTMLElement).click());
  await settle(4);
}

export async function openMenu(trigger: Element | null): Promise<void> {
  if (trigger === null) throw new Error("menu trigger not found");
  await act(async () => {
    (trigger as HTMLElement).focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle(2);
}

export function menuItem(text: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes(text));
}

export class MockEventSource {
  static instances: MockEventSource[] = [];
  onerror: (() => void) | null = null;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  close() {}
}

export function localSettings(patch: Record<string, unknown> = {}) {
  return {
    globalSkills: true,
    gitAutoCheckpointDefault: true,
    globalSkillsLocked: false,
    defaultApprovalMode: "ask" as const,
    approvalModeLocked: false,
    httpProxy: "",
    httpsProxy: "",
    allProxy: "",
    noProxy: "",
    ...patch,
  };
}

export function requirementsSettings(withSession = true) {
  return {
    configured: true,
    baseUrl: "https://requirements.example.com",
    session: withSession
      ? { user: { id: "u1", loginName: "sue", displayName: "Sue" }, expiresAt: "2026-10-28T00:00:00.000Z" }
      : null,
    mappingCount: 0,
  };
}

export function modelProviderSettings(patch: Record<string, unknown> = {}) {
  const origin = { name: { type: "user" }, version: "1" };
  return {
    configured: true,
    providerId: "gateway",
    providerName: "gateway",
    baseUrl: "https://llm.example.com/v1",
    apiKeyMasked: "由 Codex 管理",
    model: null,
    reasoningEffort: null,
    contextWindow: null,
    origins: { providerId: origin, baseUrl: origin, model: origin, reasoningEffort: origin, contextWindow: origin },
    ...patch,
  };
}

export function mcpServer(overrides: Record<string, unknown> = {}) {
  return {
    name: "filesystem",
    transport: "stdio" as const,
    enabled: true,
    command: "npx",
    args: [],
    url: null,
    envVars: [],
    bearerTokenEnvVar: null,
    startupTimeoutSeconds: null,
    toolTimeoutSeconds: null,
    status: {
      name: "filesystem",
      startupState: "ready" as const,
      startupFailureReason: null,
      authenticationStatus: "unsupported" as const,
      toolCount: 3,
    },
    ...overrides,
  };
}
