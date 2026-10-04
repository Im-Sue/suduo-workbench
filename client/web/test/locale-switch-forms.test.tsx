// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 切换语言不丢表单里已填的东西（中英双语 S9）：登录 / 注册表单带过重建；会话流往上翻着读时回到原位；
 * 需求详情的评论没发出去或正在发时，别的标签页的切换先等。
 */

const apiMocks = vi.hoisted(() => ({
  requirementsSettings: vi.fn(),
  getRequirementByNumber: vi.fn(),
  getRequirement: vi.fn(),
  listRequirementAttachments: vi.fn(),
  listArtifactVersions: vi.fn(),
  listRequirementActivity: vi.fn(),
  listRequirementsSessions: vi.fn(),
  listRequirementsMappings: vi.fn(),
  inspectLocalDir: vi.fn(),
  markRequirementRead: vi.fn(),
  listUsers: vi.fn(),
  createRequirementComment: vi.fn(),
  requirementAttachmentDownloadUrl: (id: string) => `/api/v2/attachments/${id}/content`,
  artifactVersionFileDownloadUrl: (versionId: string, fileId: string) => `/api/v2/artifact-versions/${versionId}/files/${fileId}`,
}));

vi.mock("../src/api/client.js", () => ({
  api: apiMocks,
  REQUIREMENT_ATTACHMENT_MAX_BYTES: 1_000,
  ApiClientError: class ApiClientError extends Error {},
}));
vi.mock("../src/app/shell/SessionLauncher.js", () => ({ useSessionLauncher: () => ({ launch: vi.fn() }) }));
vi.mock("../src/features/rooms/sections/RequirementRooms.js", () => ({ RequirementRooms: () => null }));

const { LoginForm } = await import("../src/app/pages/LoginForm.js");
const { ConversationStream } = await import("../src/features/sessions/stream/ConversationStream.js");
const { RequirementDetailPage } = await import("../src/features/requirements/RequirementDetailPage.js");
const { resetCarry, switchWouldLoseWork } = await import("../src/i18n/carry.js");
const { applyLocalePreference, currentLocale } = await import("../src/i18n/locale.js");
const { LocaleBoundary } = await import("../src/i18n/provider.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(element: ReactElement): Promise<HTMLDivElement> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={queryClient}>
        <LocaleBoundary>{element}</LocaleBoundary>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return container;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string): void {
  if (element === null || element === undefined) throw new Error("field not found");
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  applyLocalePreference("system");
  window.localStorage.clear();
  resetCarry();
});

describe("登录 / 注册表单", () => {
  it("已选的注册模式、填好的登录名、显示名、密码都带过重建", async () => {
    const node = await render(<LoginForm onAuthenticated={vi.fn()} />);
    const register = [...node.querySelectorAll("button")].find((button) => button.textContent === "注册新账号");
    await act(async () => register?.click());
    const fields = () => [...node.querySelectorAll<HTMLInputElement>("input")];
    expect(fields()).toHaveLength(3);
    await act(async () => {
      setValue(fields()[0], "alex");
      setValue(fields()[1], "Alex Chen");
      setValue(fields()[2], "secret-123");
    });
    const before = fields()[0];

    await act(async () => applyLocalePreference("en"));
    expect(currentLocale()).toBe("en");
    expect(fields()[0]).not.toBe(before);
    expect(fields().map((field) => field.value)).toEqual(["alex", "Alex Chen", "secret-123"]);
    expect(node.querySelector('[data-state="on"]')?.textContent).toBe("Create account");
  });
});

describe("会话流的滚动位置", () => {
  it("往上翻着读时切换：重建后回到原来的位置，不跳到底部", async () => {
    // jsdom 不做布局：按元素记下 scrollTop，内容高 2000、可视 400。
    const tops = new WeakMap<Element, number>();
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
      return tops.get(this) ?? 0;
    });
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, value: number) {
      tops.set(this, value);
    });
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(2_000);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);

    const node = await render(<ConversationStream timeline={[]} historyLoading={false} now={0} actions={{}} empty={<span />} />);
    const stream = () => node.querySelector<HTMLElement>("[data-testid='conversation-stream']");
    await act(async () => {
      const element = stream();
      if (element === null) throw new Error("stream not rendered");
      element.scrollTop = 600;
      element.dispatchEvent(new Event("scroll"));
    });
    const before = stream();

    await act(async () => applyLocalePreference("en"));
    expect(stream()).not.toBe(before);
    expect(stream()?.scrollTop).toBe(600);
  });
});

describe("需求详情的评论", () => {
  const REQ_ID = "0f6b1b3e-0a6d-4c3e-9c2e-3a1c2b4d5e6f";
  const ALEX = { id: "u1", displayName: "Alex Chen" };
  const requirement = {
    id: REQ_ID, projectId: "proj-1", number: 7, title: "结账改版", summary: "", status: "in_development" as const,
    assignee: null, commentCount: 0, attachmentCount: 0, createdBy: ALEX, updatedBy: ALEX,
    createdAt: "2026-09-29T08:00:00.000Z", updatedAt: "2026-09-29T09:00:00.000Z", version: 3, localSessionCount: 0,
  };

  beforeEach(() => {
    apiMocks.requirementsSettings.mockResolvedValue({ session: { user: ALEX } });
    apiMocks.getRequirementByNumber.mockResolvedValue(requirement);
    apiMocks.getRequirement.mockResolvedValue(requirement);
    apiMocks.listRequirementAttachments.mockResolvedValue({ items: [], requirementVersion: 3 });
    apiMocks.listArtifactVersions.mockResolvedValue({ items: [] });
    apiMocks.listRequirementActivity.mockResolvedValue({ items: [], nextCursor: null });
    apiMocks.listRequirementsSessions.mockResolvedValue({ items: [] });
    apiMocks.listRequirementsMappings.mockResolvedValue({ items: [] });
    apiMocks.markRequirementRead.mockResolvedValue(undefined);
    apiMocks.listUsers.mockResolvedValue({ items: [ALEX] });
  });

  function DetailRoute() {
    const { projectId, number } = useParams({ strict: false }) as { projectId: string; number: string };
    return <RequirementDetailPage projectId={projectId} numberRef={number} />;
  }

  it("评论写了没发、正在发：别的标签页切语言要等；发完才不等", async () => {
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const routeTree = rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/p/$projectId/requirements/$number", component: DetailRoute }),
      createRoute({ getParentRoute: () => rootRoute, path: "/p/$projectId/requirements", component: () => <div /> }),
    ]);
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/p/proj-1/requirements/7"] }) });
    const node = await render(<RouterProvider router={router} />);
    const composer = () => node.querySelector<HTMLTextAreaElement>("#comment-composer");
    expect(composer()).not.toBeNull();
    expect(switchWouldLoseWork()).toBe(false);

    await act(async () => setValue(composer(), "这一版的按钮颜色再确认一下"));
    expect(switchWouldLoseWork()).toBe(true);

    let resolveComment: (value: unknown) => void = () => undefined;
    apiMocks.createRequirementComment.mockReturnValue(new Promise((resolve) => (resolveComment = resolve)));
    const submit = [...node.querySelectorAll("button")].find((button) => button.textContent?.startsWith("发表评论"));
    await act(async () => submit?.click());
    // 输入框已清空，但请求还在路上：失败时要把正文放回来，这时也不能重建。
    expect(composer()?.value).toBe("");
    expect(switchWouldLoseWork()).toBe(true);

    await act(async () => resolveComment({ id: "c1", body: "这一版的按钮颜色再确认一下" }));
    await settle();
    expect(switchWouldLoseWork()).toBe(false);
  });
});
