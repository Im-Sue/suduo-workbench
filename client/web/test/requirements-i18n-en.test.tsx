// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementListItemDto } from "@suduo/client-contracts";
import { REQUIREMENT_STATUSES } from "@suduo/cloud-contracts";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  createRequirement: vi.fn(),
  createRequirementsSession: vi.fn(),
  getRequirement: vi.fn(),
  inspectLocalDir: vi.fn(),
  listLocalDirs: vi.fn(),
  listRequirements: vi.fn(),
  listRequirementsMappings: vi.fn(),
  listRequirementsSessions: vi.fn(),
  listUsers: vi.fn(),
  saveRequirementsMapping: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({
  api: apiMocks,
  REQUIREMENT_ATTACHMENT_MAX_BYTES: 314_572_800,
  ApiClientError: class ApiClientError extends Error {},
}));
vi.mock("@tanstack/react-router", () => ({
  // 只留下 <a> 认识的属性（aria-label、className）；路由专用的 to / params / state 去掉。
  Link: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <a href="#" {...Object.fromEntries(Object.entries(props).filter(([key]) => !["to", "params", "state"].includes(key)))}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  Toaster: () => null,
}));
// 速览里的材料、会话、活动、讨论各有自己的分区和测试，这里只看速览本身的文字。
vi.mock("../src/features/requirements/sections/Materials.js", () => ({ MaterialsPreview: () => null }));
vi.mock("../src/features/requirements/sections/LocalSessions.js", () => ({ LocalSessions: () => null }));
vi.mock("../src/features/requirements/sections/ActivityFeed.js", () => ({ ActivityFeed: () => null }));
vi.mock("../src/features/rooms/sections/RequirementRoomButton.js", () => ({ RequirementRoomButton: () => null }));

const { applyLocalePreference } = await import("../src/i18n/locale.js");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { BoardView } = await import("../src/features/requirements/components/BoardView.js");
const { ListView } = await import("../src/features/requirements/components/ListView.js");
const { CreateRequirementDialog } = await import("../src/features/requirements/components/CreateRequirementDialog.js");
const { StartSessionDialog } = await import("../src/features/requirements/components/StartSessionDialog.js");
const { RequirementPeek } = await import("../src/features/requirements/components/RequirementPeek.js");
const { AssigneeMenu } = await import("../src/features/requirements/components/AssigneeMenu.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Radix 的开关、cmdk 的列表、速览回到顶部用到 ResizeObserver / scrollIntoView / scrollTo；jsdom 没有。
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
const proto = Element.prototype as { scrollIntoView?: () => void; scrollTo?: () => void };

const range = (from: number, to: number) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;
const CJK = new RegExp(`[${range(0x3000, 0x303f)}${range(0x3400, 0x9fff)}${range(0xf900, 0xfaff)}${range(0xff00, 0xffef)}]`);

const ME = { id: "u1", displayName: "Alex Chen" };
const requirement = {
  id: "r1",
  projectId: "p1",
  number: 12,
  title: "Export orders",
  summary: "",
  status: "draft",
  assignee: null,
  commentCount: 2,
  attachmentCount: 1,
  localSessionCount: 0,
  createdBy: ME,
  updatedBy: ME,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
  version: 1,
} as unknown as RequirementListItemDto;
const session = (id: string, title: string) => ({
  id,
  projectId: "local-1",
  title,
  state: "active",
  purpose: "general",
  approvalMode: "on-request",
  createdAt: 1,
  updatedAt: 2,
  lastActivityAt: Date.now(),
  version: 1,
  threads: [],
});
const mapping = { remoteProjectId: "p1", localProjectId: "local-1", rootPath: "/code/p1", localProjectName: "p1", lastValidatedAt: 1 };
const usable = { path: "/code/p1", exists: true, isDirectory: true, readable: true, writable: true, isGitRepo: true, branch: "main" };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(view: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>{view}</TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return container;
}

const buttonByText = (name: string) =>
  Array.from(document.body.querySelectorAll("button")).find((element) => element.textContent?.trim() === name);

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  applyLocalePreference("en");
  proto.scrollIntoView = () => undefined;
  proto.scrollTo = () => undefined;
  apiMocks.listRequirements.mockImplementation(async (_projectId: string, query: { status: string }) => ({
    items: query.status === "draft" ? [requirement] : [],
    nextCursor: null,
  }));
  apiMocks.getRequirement.mockResolvedValue(requirement);
  apiMocks.listUsers.mockResolvedValue({ items: [ME, { id: "u2", displayName: "Sam Lee" }] });
  apiMocks.listRequirementsMappings.mockResolvedValue({ items: [mapping] });
  apiMocks.listRequirementsSessions.mockResolvedValue({ items: [] });
  apiMocks.inspectLocalDir.mockResolvedValue(usable);
  apiMocks.listLocalDirs.mockResolvedValue({ path: "/Users/me", parent: "/Users", home: "/Users/me", entries: [], truncated: false, recent: [] });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  applyLocalePreference("system");
  window.localStorage.clear();
});

describe("英文界面：需求看板与列表", () => {
  it("看板列名、空列提示、列头新建按钮与卡片说明", async () => {
    const node = await render(
      <BoardView
        projectId="p1"
        filters={{}}
        statuses={REQUIREMENT_STATUSES}
        selectedId={null}
        onSelect={() => undefined}
        onOpen={() => undefined}
        onCreateIn={() => undefined}
        onMove={() => undefined}
      />,
    );
    expect(node.querySelector('[data-testid="requirements-board"]')?.getAttribute("aria-label")).toBe("Requirements board");
    expect(Array.from(node.querySelectorAll("h2")).map((heading) => heading.textContent)).toEqual([
      "Draft",
      "Refining",
      "Ready",
      "In development",
      "In testing",
      "Done",
      "On hold",
    ]);
    expect(node.textContent).toContain("No requirements");
    expect(node.querySelector('[aria-label="New requirement in “Draft”"]')).not.toBeNull();
    const card = node.querySelector('[data-testid="requirement-card"]');
    expect(card?.textContent).toContain("Draft · Assignee: Unassigned · Press 1–7 to change status");
    expect(card?.querySelector('[title="2 comments"]')).not.toBeNull();
    expect(card?.querySelector('[title="1 attachment"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Press 1 to 7 to change the status.");
    expect(node.textContent).not.toMatch(CJK);
  });

  it("列表视图的表头与未指派", async () => {
    const node = await render(
      <ListView
        projectId="p1"
        filters={{}}
        statuses={REQUIREMENT_STATUSES}
        selectedId={null}
        onSelect={() => undefined}
        onOpen={() => undefined}
        onCreateIn={() => undefined}
      />,
    );
    const list = node.querySelector('[data-testid="requirements-list"]');
    expect(list?.getAttribute("aria-label")).toBe("Requirements list");
    // 计数列的表头是图标（S9 走查：112px 放不下英文表头）；读屏读隐藏的文字，悬停看 title。
    const cells = Array.from(list?.firstElementChild?.children ?? []);
    expect(cells.map((cell) => cell.querySelector(".sr-only")?.textContent ?? cell.textContent)).toEqual([
      "ID",
      "Title",
      "Assignee",
      "Materials · Comments · Sessions",
      "Updated",
    ]);
    const counts = cells[3];
    expect(counts?.getAttribute("title")).toBe("Materials · Comments · Sessions");
    expect(counts?.querySelector('[aria-hidden="true"]')?.querySelectorAll("svg")).toHaveLength(3);
    // 「Yesterday 10:35」与「2025年12月27日」都要一行放下：更新列 96px。
    expect(cells[4]?.className).toContain("w-24");
    expect(node.querySelector('[data-testid="requirement-row"]')?.textContent).toContain("Unassigned");
    expect(node.querySelector('[data-testid="requirement-row"] time')?.className).toContain("w-24");
    expect(node.textContent).not.toMatch(CJK);
  });
});

describe("英文界面：新建需求对话框", () => {
  it("标题、按钮、必填提示与属性按钮", async () => {
    await render(
      <CreateRequirementDialog
        open
        onOpenChange={() => undefined}
        projectId="p1"
        projectName="Checkout"
        initialStatus="in_testing"
        currentUser={null}
        onView={() => undefined}
      />,
    );
    const dialog = document.body.querySelector('[data-testid="create-requirement-dialog"]');
    expect(dialog?.textContent).toContain("New requirement");
    expect(dialog?.querySelector('[aria-label="Status: In testing"]')).not.toBeNull();
    expect(dialog?.querySelector('[aria-label="Assignee: Unassigned"]')).not.toBeNull();
    expect(dialog?.querySelector<HTMLInputElement>("#new-requirement-title")?.placeholder).toBe("Requirement title");
    expect(dialog?.textContent).toContain("Add materials");
    expect(dialog?.textContent).toContain("Create another");
    expect(buttonByText("Cancel")).toBeDefined();
    await act(async () => buttonByText("Create requirement⌘⏎")?.click());
    expect(dialog?.textContent).toContain("Add a title so everyone can recognize it on the board");
    expect(apiMocks.createRequirement).not.toHaveBeenCalled();
    expect(dialog?.textContent).not.toMatch(CJK);
  });
});

describe("英文界面：开始会话对话框", () => {
  it("需求已有会话时的选择步骤", async () => {
    apiMocks.listRequirementsSessions.mockResolvedValue({
      items: [{ session: session("s-old", "Split export tasks"), requirement: { remoteRequirementId: "r1", requirementVersion: 1, createdAt: 1 } }],
    });
    await render(
      <StartSessionDialog
        request={{ kind: "requirement", remoteProjectId: "p1", requirementId: "r1" }}
        subject="REQ-12 Export orders"
        onClose={() => undefined}
        onReady={() => undefined}
      />,
    );
    const dialog = document.body.querySelector('[data-testid="start-session-dialog"]');
    expect(dialog?.querySelector("h2")?.textContent).toBe("Start session");
    expect(dialog?.textContent).toContain("This requirement already has a local session.");
    expect(dialog?.textContent).toContain("Most recent · Last active: just now");
    expect(buttonByText("New session")).toBeDefined();
    expect(dialog?.textContent).not.toMatch(CJK);
  });

  it("选目录步骤与目录检查结果", async () => {
    apiMocks.listRequirementsMappings.mockResolvedValueOnce({ items: [] });
    await render(
      <StartSessionDialog
        request={{ kind: "project", remoteProjectId: "p1" }}
        subject="Checkout"
        onClose={() => undefined}
        onReady={() => undefined}
      />,
    );
    const dialog = document.body.querySelector('[data-testid="start-session-dialog"]');
    expect(dialog?.querySelector("h2")?.textContent).toBe("Choose local folder");
    expect(dialog?.textContent).toContain("No subfolders here");
    await act(async () => buttonByText("Enter path manually")?.click());
    await act(async () => typeInto(document.body.querySelector<HTMLInputElement>("#directory-manual")!, "/code/p1"));
    await settle();
    expect(dialog?.textContent).toContain("Can read and write · Git repository · On branch main");
    expect(buttonByText("Use this folder")).toBeDefined();
    expect(dialog?.textContent).not.toMatch(CJK);
  });
});

describe("英文界面：速览与菜单", () => {
  it("速览面板的标题、属性、空描述与底部按钮", async () => {
    const node = await render(
      <RequirementPeek
        projectId="p1"
        requirementId="r1"
        currentUserId="u1"
        onClose={() => undefined}
        onPrev={null}
        onNext={null}
        onStartSession={() => undefined}
      />,
    );
    const peek = node.querySelector('[data-testid="requirement-peek"]');
    expect(peek?.getAttribute("aria-label")).toBe("Requirement preview: REQ-12 Export orders");
    expect(Array.from(peek?.querySelectorAll("dt") ?? []).map((term) => term.textContent)).toEqual(["Assignee", "Created", "Updated"]);
    expect(peek?.querySelector('[aria-label="Status: Draft, click to change"]')).not.toBeNull();
    expect(peek?.querySelector('[aria-label="Assignee: Unassigned, click to change"]')).not.toBeNull();
    expect(peek?.querySelector('[aria-label="Close preview"]')).not.toBeNull();
    expect(peek?.textContent).toContain("No description yet. Add one");
    expect(buttonByText("Start session")).toBeDefined();
    expect(peek?.textContent).toContain("Open full page");
    expect(peek?.textContent).not.toMatch(CJK);
  });

  it("负责人菜单：搜索框、未指派与「我」", async () => {
    await render(
      <AssigneeMenu assignee={null} currentUserId="u1" onChange={() => undefined}>
        <button type="button">Pick assignee</button>
      </AssigneeMenu>,
    );
    await act(async () => buttonByText("Pick assignee")?.click());
    await settle();
    const input = document.body.querySelector<HTMLInputElement>("[cmdk-input]");
    expect(input?.placeholder).toBe("Search members");
    const options = Array.from(document.body.querySelectorAll("[cmdk-item]")).map((item) => item.textContent);
    // 每项前面是头像的首字母。
    expect(options).toHaveLength(3);
    expect(options[0]).toContain("Unassigned");
    expect(options[1]).toMatch(/Alex Chen\(you\)$/);
    expect(options[2]).toMatch(/Sam Lee$/);
  });
});
